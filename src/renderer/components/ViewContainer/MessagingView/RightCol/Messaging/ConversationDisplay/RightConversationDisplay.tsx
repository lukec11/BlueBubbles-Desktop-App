/* eslint-disable class-methods-use-this */
/* eslint-disable max-len */
/* eslint-disable no-underscore-dangle */
import * as React from "react";
import { ipcRenderer } from "electron";
import { Chat, Message as DBMessage } from "@server/databases/chat/entity";
import { getDateText, getTimeText } from "@renderer/utils";
import ClickNHold from "react-click-n-hold";

import "./RightConversationDisplay.css";
import ChatLabel from "./ChatLabel";
import MessageBubble from "./MessageBubble";
import ReactionParticipant from "./ReactionParticipant/ReactionParticipant";

type Props = {
    chat: Chat;
};

type State = {
    isLoading: boolean;
    messages: Message[];
    isReactionsOpen: boolean;
};

type Message = DBMessage & {
    tempGuid: string;
    reactions: DBMessage[];
    reactionsChecked: boolean;
};

const getChatEvent = (message: Message) => {
    const sender = message.isFromMe || !message.handle ? "You" : message.handle.address ?? "";
    if (message.itemType === 2)
        return (
            <ChatLabel
                text={`${sender} named the conversation "${message.groupTitle}"`}
                date={new Date(message.dateCreated)}
            />
        );

    return null;
};

const deduplicateReactions = (reactions: DBMessage[]) => {
    const uniqueReactions: { [key: string]: DBMessage } = {};
    for (const reaction of reactions) {
        // Let's build a unique string representing the person who made the reaction
        // We can't only use handleId because it's inconsistant for groups vs. single conversations
        // We are going to use a combination of handleId and isFromMe
        const key = `${reaction.handleId ?? "none"}:${reaction.isFromMe}`;

        // Next, let's check if the key exists in the tracker object (uniqueReactions)
        // If it doesn't exist, just add it. Otherwise, compare the date before adding/replacing
        if (!Object.keys(uniqueReactions).includes(key)) {
            uniqueReactions[key] = reaction;
        } else if (reaction.dateCreated > uniqueReactions[key].dateCreated) {
            uniqueReactions[key] = reaction;
        }
    }

    return Object.values(uniqueReactions);
};

class RightConversationDisplay extends React.Component<Props, State> {
    constructor(props) {
        super(props);

        this.state = {
            isLoading: false,
            messages: [],
            isReactionsOpen: false
        };
    }

    componentDidMount() {
        ipcRenderer.on("message", async (_, payload: { message: Message; tempGuid?: string }) => {
            const { message } = payload;

            // If the message isn't for this chat, ignore it
            if (!message.chats || message.chats[0].guid !== this.props.chat.guid) return;

            // Convert the message to a message with a tempGuid
            const msg = message as Message;
            msg.tempGuid = payload.tempGuid ?? null;

            // Otherwise, add the message to the state
            await this.addMessagesToState([msg]);

            // Scroll to new message
            const view = document.getElementById("messageView");
            view.scrollTop = view.scrollHeight;
        });

        ipcRenderer.on("add-message", async (_, message) => {
            // Otherwise, add the message to the state
            await this.addMessagesToState([message]);

            // Scroll to new message
            const view = document.getElementById("messageView");
            view.scrollTop = view.scrollHeight;
        });

        this.chatChange();
    }

    componentDidUpdate(prevProps) {
        if (this.props.chat?.guid !== prevProps.chat?.guid) {
            this.chatChange();
        }
    }

    async getNextMessagePage() {
        let messageTimestamp = null;
        if (this.state.messages.length > 0) {
            messageTimestamp = this.state.messages[0].dateCreated;
        }

        // Set the loading state
        this.setState({ isLoading: true });

        // Get the next page of messages
        const messages: DBMessage[] = await ipcRenderer.invoke("get-chat-messages", {
            chatGuid: this.props.chat.guid,
            withHandle: true,
            withAttachments: true,
            withChat: false,
            limit: 25,
            before: messageTimestamp ?? new Date().getTime(),
            where: []
        });

        // Add each message to the state
        await this.addMessagesToState(messages as Message[]); // These won't have a tempGuid

        // Tell the state we are done loading
        this.setState({ isLoading: false }, () => {
            // If this is a fresh chat, scroll to the bottom
            if (!messageTimestamp) {
                const view = document.getElementById("messageView");
                view.scrollTop = view.scrollHeight;
            }
        });
    }

    async fetchReactions(messages: Message[]) {
        const updatedMessages = [...messages];
        const stateMessages = [...this.state.messages];
        let hasUpdates = false;
        for (let i = 0; i < updatedMessages.length; i += 1) {
            // Fetch the message reactions
            updatedMessages[i].reactions = await ipcRenderer.invoke("get-reactions", updatedMessages[i]);
            if (updatedMessages[i].reactions.length > 0) hasUpdates = true;

            // Since a person can change their reaction, it creates 1 "message" per change
            // This will cause multiple reactions per-person if not de-duplicated. Let's do that.
            updatedMessages[i].reactions = deduplicateReactions(updatedMessages[i].reactions);

            // Find the corresponding state message and update it
            for (let x = 0; x < stateMessages.length; x += 1) {
                if (stateMessages[x].guid === updatedMessages[i].guid) {
                    stateMessages[x].reactions = updatedMessages[i].reactions;
                    break;
                }
            }
        }

        // Update the state with the new message reactions
        if (hasUpdates) this.setState({ messages: stateMessages });
    }

    chatChange() {
        // Reset the messages
        this.setState({ messages: [] }, () => {
            // Set the text field to active
            const msgField = document.getElementById("messageFieldInput");
            if (msgField) msgField.focus();

            // Get new messages
            this.getNextMessagePage();
        });
    }

    async detectTop(e: React.UIEvent<HTMLDivElement, UIEvent>) {
        // First check if we are at the top
        if (e.currentTarget.scrollTop === 0) {
            // Save the current size
            const currentSize = e.currentTarget.scrollHeight;

            // Get the next page
            await this.getNextMessagePage();

            // Get the current view & its' size
            const view = document.getElementById("messageView");
            const newSize = view.scrollHeight;

            // Set the scroll position
            view.scrollTo(0, newSize - currentSize);
        }
    }

    async addMessagesToState(messages: Message[]) {
        // Make copies of state
        const updatedMessages = [...this.state.messages];

        // Add to the state if
        for (const message of messages) {
            // Check if the message already exists (via real GUID or temp GUID)
            const opts = message.tempGuid ? [message.guid, message.tempGuid] : [message.guid];
            const exists = updatedMessages.findIndex(i => opts.includes(i.guid));
            if (exists === -1) {
                updatedMessages.push(message);
            } else {
                updatedMessages[exists] = message;
            }
        }

        // De-duplicate the messages (as a fail-safe)
        const outputMessages: Message[] = [];
        for (const i of updatedMessages) {
            let exists = false;
            for (const k of outputMessages) {
                if (i.guid === k.guid) {
                    exists = true;
                    break;
                }
            }

            if (!exists) outputMessages.push(i);
        }

        // For each message, check if there are any reactions for it
        const messageList: Message[] = [];
        const reactionList: Message[] = [];
        for (let i = 0; i < outputMessages.length; i += 1) {
            // console.log(outputMessages[i].text);
            // console.log(outputMessages[i].hasReactions);
            if (
                outputMessages[i].hasReactions &&
                !outputMessages[i].reactionsChecked &&
                !outputMessages[i].associatedMessageGuid
            ) {
                // Set flags telling the FE to not fetch reactions for them again
                outputMessages[i].reactionsChecked = true;
                outputMessages[i].reactions = [];

                // Add to list
                messageList.push(outputMessages[i]);
            } else if (outputMessages[i].associatedMessageGuid) {
                reactionList.push(outputMessages[i]);
            }
        }

        // For each reaction, find the corresponding message, and merge the reactions
        for (const reaction of reactionList) {
            for (let i = 0; i < outputMessages.length; i += 1) {
                if (reaction.associatedMessageGuid === outputMessages[i].guid) {
                    outputMessages[i].reactions = deduplicateReactions([...outputMessages[i].reactions, reaction]);
                    break;
                }
            }
        }

        // Update the state (and wait for it to finish)
        await new Promise((resolve, _) =>
            this.setState({ messages: outputMessages.filter(i => !i.associatedMessageGuid) }, resolve)
        );

        // Asynchronously fetch the reactions
        this.fetchReactions(messageList);

        return true;
    }

    end(e, enough) {
        console.log("END");
        console.log(enough ? "Click released after enough time" : "Click released too soon");
    }

    start(e) {
        console.log("START");
    }

    clickNHold(message) {
        const parent = document.getElementById(message.guid);
        if (!parent) return;

        parent.classList.toggle("activeReactionMessage");
        parent.style.setProperty("--hide-pseudo", "0");

        this.setState({ isReactionsOpen: true });
    }

    closeReactionView() {
        document.getElementsByClassName("activeReactionMessage")[0].classList.toggle("activeReactionMessage");
        this.setState({ isReactionsOpen: false });
    }

    handleQuestionMarkEnter() {
        document.getElementById("mark").style.stroke = getComputedStyle(
            document.getElementsByClassName("TitleBar")[0]
        ).getPropertyValue("--outgoing-message-color");
        document.getElementById("dot").style.fill = getComputedStyle(
            document.getElementsByClassName("TitleBar")[0]
        ).getPropertyValue("--outgoing-message-color");
    }

    handleQuestionMarkLeave() {
        document.getElementById("mark").style.stroke = getComputedStyle(
            document.getElementsByClassName("TitleBar")[0]
        ).getPropertyValue("--sub-title-color");
        document.getElementById("dot").style.fill = getComputedStyle(
            document.getElementsByClassName("TitleBar")[0]
        ).getPropertyValue("--sub-title-color");
    }

    render() {
        const { messages, isLoading } = this.state;
        const { chat } = this.props;

        if (!chat) return <div className="RightConversationDisplay" />;

        let chatTitle = chat.displayName;
        if (!chatTitle) {
            const list = chat.participants.map(i => i.address);
            if (list.length === 1) {
                chatTitle = list.join(", ");
            } else {
                chatTitle = "Group Chat";
            }
        }

        const date = messages.length > 0 ? new Date(messages[0].dateCreated) : null;
        messages.sort((a, b) => (a.dateCreated > b.dateCreated ? 1 : -1));

        return (
            <div id="messageView" onScroll={e => this.detectTop(e)} className="RightConversationDisplay">
                {isLoading ? <div id="loader" /> : null}

                {this.state.isReactionsOpen ? (
                    <div id="reactionOverlay" onClick={() => this.closeReactionView()}>
                        <div id="reactionParticipantsDiv">
                            <ReactionParticipant reactionSender="Maxwell" reactionType="Like" />
                        </div>
                        <div id="newReactionDiv">
                            <svg version="1.1" id="lovedIcon" className="reactionIcon" viewBox="0 0 391.837 391.837">
                                <g>
                                    <path
                                        d="M285.257,35.528c58.743,0.286,106.294,47.836,106.58,106.58
		c0,107.624-195.918,214.204-195.918,214.204S0,248.165,0,142.108c0-58.862,47.717-106.58,106.58-106.58l0,0
		c36.032-0.281,69.718,17.842,89.339,48.065C215.674,53.517,249.273,35.441,285.257,35.528z"
                                    />
                                </g>
                            </svg>
                            <svg
                                version="1.1"
                                id="likeIcon"
                                className="reactionIcon"
                                viewBox="596.9167 0.0194 1565.0834 1639.8086"
                                enableBackground="new 596.9167 0.0194 1565.0834 1639.8086"
                            >
                                <path
                                    d="M1520.5629,60.7246c9.2529,0,22.9001-2.2927,31.0228,1.2784c4.0228,1.7685,10.0901,1.592,14.4762,2.7188
	c5.8456,1.5018,11.6852,2.95,17.423,4.8376c19.8309,6.524,38.4539,17.5962,54.3069,31.1189
	c15.4873,13.2107,28.811,28.8823,38.5651,46.7913c10.3126,18.9348,15.6564,39.2017,20.9418,59.9346
	c5.438,21.3307,6.3975,44.4503,6.5536,66.3782c0.1575,22.0935-1.3568,45.1182-6.2789,66.6433
	c-4.7166,20.626-9.5502,40.6268-17.2726,60.4215c-8.1235,20.8223-19.2517,40.6216-29.2167,60.5945
	c-9.6312,19.3036-18.8459,38.775-28.1715,58.2219c-9.0332,18.8382-17.9552,38.7832-24.1283,58.7702
	c-6.0906,19.7205-11.4923,40.3191-10.5479,61.155c0.3005,6.6298,1.0413,21.0134,7.0928,25.2928
	c3.0446,2.1529,8.7776,0.9438,12.2129,0.8727c6.3768-0.1321,12.7501-0.3911,19.1221-0.6643
	c46.1556-1.9804,92.4683-1.7981,138.6613-1.7421c45.6135,0.0554,91.168,0.327,136.7052,3.2466
	c22.5062,1.4431,45.473,2.3863,67.7657,5.9072c20.1079,3.1758,39.5485,8.5963,55.7,21.558
	c15.6963,12.5963,29.2531,29.2695,40.9388,45.5461c11.8752,16.5402,23.2302,34.9225,30.1526,54.1568
	c3.2183,8.9421,6.8928,18.6378,7.8779,28.1332c1.1016,10.6202-0.9648,19.2577-6.2202,28.4807
	c-10.1318,17.7805-24.4211,32.9326-35.489,50.126c-5.583,8.6729-9.6936,17.2821-8.1272,27.8564
	c1.5747,10.6291,6.9783,20.636,12.1709,29.8923c9.8293,17.5203,21.5195,34.1235,30.4695,52.1269
	c4.1145,8.2762,7.9856,17.6038,7.1602,27.0314c-0.873,9.9706-6.8962,18.98-12.7485,26.7786
	c-12.3955,16.5182-27.3953,30.9061-39.7224,47.4825c-5.7537,7.7368-11.4421,16.1678-11.7715,26.1475
	c-0.349,10.5802,2.4435,20.917,6.0121,30.7833c7.3593,20.3463,17.4034,40.3459,23.2218,61.1707
	c6.0962,21.8181-0.4746,39.7147-13.5889,57.3821c-12.5927,16.9652-28.8911,30.9794-43.8359,45.7869
	c-14.4075,14.2753-27.1533,28.6671-27.001,50.0262c0.078,10.9647,0.1594,21.9293,0.2654,32.8938
	c0.1068,11.0503,1.4434,22.9386-1.6632,33.6997c-5.4886,19.0134-21.4039,36.1284-34.7365,50.1152
	c-14.4594,15.1687-30.6368,28.7886-47.7722,40.8331c-17.229,12.1102-34.8148,20.5139-55.1942,25.6375
	c-20.9213,5.2599-42.9412,7.8329-64.4313,9.6827c-90.5679,7.7957-181.6688,2.4065-272.3201-0.8159
	c-44.7479-1.5908-89.6749-4.4669-134.2426-8.8455c-10.2728-1.0093-20.5367-1.4325-30.8199-2.1771
	c-10.1438-0.7345-20.5139-3.3689-30.5206-5.2036c-21.0529-3.8597-42.129-7.6986-63.1381-11.7871
	c-42.7938-8.328-85.7592-15.8619-128.62-23.8524c-21.6165-4.0298-43.25-7.9535-64.874-11.9396
	c-10.5157-1.9385-21.0328-3.881-31.521-5.9642c-3.2131-0.6381-6.5777-1.077-7.1765-4.8949
	c-0.9216-5.8757-0.113-12.4637-0.1102-18.4089c0.0895-185.7694,0.0862-371.5388,0.087-557.3082
	c0.0001-11.146,0.0001-22.2924,0.0002-33.4384c0-2.7115-0.8728-7.2691,0.6964-9.6804c1.8351-2.8201,9.785-1.3683,12.4819-1.3834
	c9.8492-0.0552,19.8955,0.8073,29.6094-1.1854c9.9312-2.0372,19.0519-6.6622,27.5282-12.1067
	c34.0913-21.8972,59.651-57.7686,81.01-91.4886c23.2795-36.7521,43.9276-75.4404,62.1334-114.9429
	c18.3373-39.788,34.3848-80.5327,51.8765-120.6971c17.0248-39.0923,48.2561-65.2728,80.8578-91.2554
	c16.4827-13.1361,32.6666-26.548,46.3193-42.7003c13.8022-16.3293,24.9845-34.8267,33.7615-54.2959
	c18.1166-40.1859,30.1417-84.3115,36.2227-127.9681c6.2136-44.6116,12.6005-89.2005,14.9655-134.2462
	c0.3915-7.4563,1.6073-14.5817,7.3704-19.8748c2.4473-2.2476,5.3876-3.8947,8.4872-5.0599
	C1513.9449,63.4004,1519.2778,63.2971,1520.5629,60.7246C1530.4342,60.7246,1519.7723,62.3071,1520.5629,60.7246z
	 M654.1641,898.2689c0,113.5108,0,227.0218,0,340.5325c0,46.5209,0,93.0417,0,139.5626c0,23.2604,0,46.5209,0,69.7813
	c0,12.0956,0,24.1909,0,36.2863c0,5.5826,0,11.165,0,16.7476c2.9518,0.6001,3.0689,7.4297,3.9023,9.6901
	c5.8673,15.9106,20.7537,29.5836,36.6451,35.1024c9.34,3.2439,18.8117,3.2965,28.5798,3.3029
	c11.0439,0.0074,22.0878,0.012,33.1318,0.0145c46.0164,0.0112,92.0328-0.0095,138.0493,0.0101
	c19.0814,0.0082,36.9496-6.9194,49.56-21.6554c13.4414-15.7072,14.5669-34.699,14.5618-54.4558
	c-0.012-46.6202-0.0196-93.2406-0.025-139.8608c-0.0109-93.2407-0.0132-186.4812-0.0248-279.7219
	c-0.0057-46.3734,1.1533-92.9179-0.0865-139.2733c-0.5342-19.9727-7.4376-38.3519-23.3443-51.1132
	c-15.4163-12.3679-33.5844-13.338-52.5065-13.3804c-46.3998-0.1041-92.7999-0.1375-139.1995-0.0057
	c-20.9935,0.0595-42.7304-1.9652-61.1382,10.0648c-7.4174,4.8474-13.9482,11.0446-18.7111,18.5484
	c-2.1867,3.4451-3.9904,7.1271-5.4059,10.9533C657.395,891.446,656.8574,897.8079,654.1641,898.2689
	C654.1641,1099.2389,655.7422,897.9987,654.1641,898.2689z"
                                />
                            </svg>
                            <svg id="dislikeIcon" className="reactionIcon" viewBox="0 0 1567 1640">
                                <path d="M611.33 1577.84C607.31 1576.08 601.24 1576.25 596.86 1575.13C591.01 1573.62 585.17 1572.18 579.43 1570.29C559.6 1563.76 540.98 1552.69 525.13 1539.17C509.64 1525.96 496.31 1510.29 486.56 1492.38C476.25 1473.44 470.9 1453.18 465.62 1432.44C460.18 1411.11 459.22 1387.99 459.06 1366.07C458.91 1343.97 460.42 1320.95 465.34 1299.42C470.06 1278.8 474.89 1258.8 482.62 1239C490.74 1218.18 501.87 1198.38 511.83 1178.41C521.46 1159.1 530.68 1139.63 540 1120.18C549.04 1101.35 557.96 1081.4 564.13 1061.41C570.22 1041.69 575.62 1021.09 574.68 1000.26C574.38 993.63 573.64 979.25 567.59 974.97C564.54 972.81 558.81 974.02 555.37 974.09C549 974.23 542.62 974.48 536.25 974.76C490.1 976.74 443.78 976.56 397.59 976.5C351.98 976.44 306.42 976.17 260.89 973.25C238.38 971.81 215.41 970.87 193.12 967.35C173.01 964.17 153.57 958.75 137.42 945.79C121.72 933.19 108.17 916.52 96.48 900.24C84.61 883.7 73.25 865.32 66.33 846.09C63.11 837.14 59.44 827.45 58.45 817.95C57.35 807.33 59.42 798.69 64.67 789.47C74.8 771.69 89.09 756.54 100.16 739.35C105.74 730.67 109.85 722.06 108.29 711.49C106.71 700.86 101.31 690.85 96.12 681.6C86.29 664.08 74.6 647.47 65.65 629.47C61.53 621.19 57.66 611.87 58.49 602.44C59.36 592.47 65.38 583.46 71.24 575.66C83.63 559.14 98.63 544.75 110.96 528.18C116.71 520.44 122.4 512.01 122.73 502.03C123.08 491.45 120.29 481.11 116.72 471.25C109.36 450.9 99.31 430.9 93.5 410.08C87.4 388.26 93.97 370.36 107.08 352.69C119.68 335.73 135.98 321.71 150.92 306.91C165.33 292.63 178.07 278.24 177.92 256.88C177.84 245.92 177.76 234.95 177.66 223.99C177.55 212.94 176.21 201.05 179.32 190.29C184.81 171.27 200.72 154.16 214.06 140.17C228.52 125 244.69 111.38 261.83 99.34C279.06 87.23 296.64 78.82 317.02 73.7C337.94 68.44 359.96 65.87 381.45 64.02C472.02 56.22 563.12 61.61 653.77 64.83C698.52 66.43 743.45 69.3 788.02 73.68C798.29 74.69 808.55 75.11 818.84 75.86C828.98 76.59 839.35 79.23 849.36 81.06C870.41 84.92 891.49 88.76 912.49 92.85C955.29 101.18 998.25 108.71 1041.11 116.7C1062.73 120.73 1084.36 124.65 1105.99 128.64C1116.5 130.58 1127.02 132.52 1137.51 134.6C1140.72 135.24 1144.09 135.68 1144.69 139.5C1145.61 145.37 1144.8 151.96 1144.8 157.91C1144.71 343.68 1144.71 529.45 1144.71 715.22C1144.71 726.36 1144.71 737.51 1144.71 748.65C1144.71 751.37 1145.58 755.92 1144.01 758.33C1142.18 761.15 1134.23 759.7 1131.53 759.72C1121.68 759.77 1111.64 758.91 1101.92 760.9C1091.99 762.94 1082.87 767.57 1074.39 773.01C1040.3 794.91 1014.74 830.78 993.38 864.5C970.1 901.25 949.46 939.94 931.25 979.44C912.91 1019.23 896.87 1059.97 879.37 1100.14C862.35 1139.23 831.12 1165.41 798.52 1191.39C782.03 1204.53 765.85 1217.94 752.2 1234.09C738.39 1250.42 727.21 1268.92 718.43 1288.39C700.32 1328.58 688.29 1372.7 682.21 1416.36C676 1460.97 669.61 1505.56 667.25 1550.6C666.86 1558.06 665.64 1565.19 659.88 1570.48C657.43 1572.73 654.49 1574.37 651.39 1575.54C648.97 1576.45 643.64 1576.55 642.35 1579.12C642.35 1579.12 642.35 1579.12 642.35 1579.12C632.48 1579.12 643.14 1577.54 642.35 1579.12C642.35 1579.12 642.35 1579.12 642.35 1579.12C633.1 1579.12 619.45 1581.42 611.33 1577.84ZM1508.75 741.58C1508.75 741.58 1508.75 741.58 1508.75 741.58C1507.17 741.85 1508.75 540.61 1508.75 741.58C1508.75 741.58 1508.75 741.58 1508.75 741.58C1506.06 742.04 1505.52 748.4 1504.76 750.45C1503.35 754.27 1501.55 757.96 1499.36 761.4C1494.6 768.91 1488.06 775.1 1480.65 779.95C1462.24 791.98 1440.5 789.96 1419.51 790.01C1373.11 790.15 1326.71 790.11 1280.31 790.01C1261.39 789.97 1243.22 789 1227.8 776.63C1211.9 763.87 1204.99 745.49 1204.46 725.52C1203.22 679.16 1204.38 632.62 1204.37 586.24C1204.36 493 1204.36 399.76 1204.35 306.52C1204.34 259.9 1204.33 213.28 1204.32 166.66C1204.32 146.9 1205.44 127.91 1218.88 112.2C1231.49 97.47 1249.36 90.54 1268.44 90.55C1314.46 90.57 1360.48 90.55 1406.49 90.56C1417.54 90.56 1428.58 90.57 1439.63 90.57C1449.39 90.58 1458.87 90.63 1468.21 93.88C1484.1 99.39 1498.98 113.07 1504.85 128.98C1505.68 131.24 1505.8 138.07 1508.75 138.67C1508.75 144.25 1508.75 149.83 1508.75 155.42C1508.75 167.51 1508.75 179.61 1508.75 191.7C1508.75 214.96 1508.75 238.22 1508.75 261.48C1508.75 308 1508.75 354.53 1508.75 401.05C1508.75 514.56 1508.75 628.07 1508.75 741.58Z" />
                            </svg>
                            <svg id="hahaIcon" className="reactionIcon" viewBox="0 0 1000 1000">
                                <path d="M95.986,181.179q-1.155,39.285,1.155,85.887t9.244,95.515q6.931,48.925,19.257,89.353t31.581,66.629q19.245,26.2,46.217,26.96,24.644,0.777,39.67-8.858A68.591,68.591,0,0,0,266.6,511.631a106.261,106.261,0,0,0,11.554-34.663,211.842,211.842,0,0,0,2.7-37.744,334.7,334.7,0,0,0-2.311-33.892q-1.932-15.4-3.466-23.879-1.553-6.933,5.392-12.325,6.156-3.844,10.784-2.7a22.15,22.15,0,0,1,8.473,4.237q5.379,3.087,3.851,11.554-1.553,6.933-4.236,21.183a264.1,264.1,0,0,0-3.852,31.582,277.907,277.907,0,0,0,0,35.818,121.217,121.217,0,0,0,6.933,34.277,67.309,67.309,0,0,0,17.331,26.575q11.555,10.8,31.582,13.1,35.421,3.846,59.7-22.723t38.9-70.866q14.624-44.286,20.8-100.137a997.921,997.921,0,0,0,6.162-109.381q0-53.527-5.777-98.6t-14.25-68.94Q446.844,46.38,430.289,30.2,413.716,14.028,394.856,9.791A58.922,58.922,0,0,0,357.5,13.642Q339.01,21.73,324.375,41.758A104.629,104.629,0,0,0,308.969,74.11,246.107,246.107,0,0,0,298.955,141.9v20.8q0,6.933-4.621,10.014-3.864,3.087-6.933,1.541a10.009,10.009,0,0,1-4.622-4.622,11.236,11.236,0,0,1-2.31-6.933q0-38.508-4.622-68.555T260.056,44.069q-11.175-20.021-30.041-28.886-18.883-8.846-46.6-5.777-26.2,3.863-42.366,20.8A124.165,124.165,0,0,0,116.4,66.792q-8.486,19.642-11.554,36.2-3.087,16.573-3.851,18.872Q97.129,141.907,95.986,181.179Zm797.619,50.069q-10.8-70.084-33.507-119.78Q837.369,61.785,802.326,34.44,767.267,7.107,718.751,7.1A156.371,156.371,0,0,0,634.79,30.974Q596.264,54.859,569.7,103.38T530.416,225.47q-12.71,73.569-6.547,172.929,2.31,36.216,11.554,63.934t22.724,46.217q13.467,18.486,30.041,27.73,16.554,9.243,33.507,9.243,20.8,0,35.818-10.013a81.653,81.653,0,0,0,24.649-25.805,149.45,149.45,0,0,0,15.406-35.048,319.527,319.527,0,0,0,8.858-36.973c0.506-3.082,2.311-4.49,5.392-4.237s4.875,1.673,5.392,4.237a284.774,284.774,0,0,0,7.318,39.284,116.943,116.943,0,0,0,15.02,34.663,79.9,79.9,0,0,0,25.8,25.034q15.779,9.64,39.669,9.629,43.906,0,71.637-40.825t27.73-117.854Q904.389,301.356,893.605,231.248Zm-191.03,9.628q6.931-8.845,13.095-11.939,6.156-3.069,11.554-1.541a27.5,27.5,0,0,1,10.014,5.392q10.777,9.243,20.027,33.122-13.107-7.69-25.42-8.473a105.32,105.32,0,0,0-22.338.771,77.273,77.273,0,0,0-21.568,7.7Q695.631,249.734,702.575,240.876ZM184.665,692.134q-0.951,32.365.952,70.758t7.615,78.69A487.213,487.213,0,0,0,209.1,915.2q10.145,33.316,26.019,54.893,15.855,21.582,38.076,22.211,20.3,0.639,32.681-7.3a56.51,56.51,0,0,0,19.356-20.624,87.546,87.546,0,0,0,9.519-28.557,174.624,174.624,0,0,0,2.221-31.1,276.024,276.024,0,0,0-1.9-27.923q-1.591-12.687-2.856-19.672-1.28-5.712,4.442-10.154,5.073-3.168,8.885-2.221a18.251,18.251,0,0,1,6.98,3.49q4.432,2.544,3.173,9.519-1.278,5.712-3.49,17.452a217.888,217.888,0,0,0-3.173,26.018,228.73,228.73,0,0,0,0,29.509,99.909,99.909,0,0,0,5.711,28.24,55.459,55.459,0,0,0,14.279,21.893q9.519,8.9,26.018,10.788,29.183,3.168,49.182-18.72t32.047-58.383q12.046-36.484,17.134-82.5a822.141,822.141,0,0,0,5.077-90.113,641.176,641.176,0,0,0-4.76-81.228q-4.76-37.124-11.74-56.8-8.254-22.845-21.893-36.172-13.654-13.326-29.192-16.817a48.545,48.545,0,0,0-30.778,3.173q-15.229,6.664-27.288,23.163a86.206,86.206,0,0,0-12.692,26.653,202.711,202.711,0,0,0-8.249,55.845V676.9q0,5.712-3.808,8.25-3.183,2.543-5.711,1.269a8.24,8.24,0,0,1-3.808-3.808,9.253,9.253,0,0,1-1.9-5.711,374.653,374.653,0,0,0-3.807-56.479q-3.808-24.75-13.009-41.249t-24.75-23.8q-15.556-7.288-38.393-4.76-21.58,3.183-34.9,17.134A102.3,102.3,0,0,0,201.482,597.9a140.888,140.888,0,0,0-9.519,29.826q-2.542,13.653-3.173,15.547Q185.607,659.781,184.665,692.134Zm657.118,41.249q-8.894-57.738-27.605-98.68t-47.6-63.459Q737.7,548.725,697.73,548.715a128.824,128.824,0,0,0-69.172,19.673q-31.738,19.677-53.623,59.652T542.57,728.624q-10.47,60.609-5.394,142.467,1.9,29.837,9.519,52.671t18.721,38.076q11.1,15.231,24.749,22.846A56.08,56.08,0,0,0,617.77,992.3q17.135,0,29.509-8.25a67.265,67.265,0,0,0,20.307-21.259,123.1,123.1,0,0,0,12.692-28.874,263.3,263.3,0,0,0,7.3-30.461c0.416-2.538,1.9-3.7,4.442-3.49s4.016,1.378,4.442,3.49a234.6,234.6,0,0,0,6.029,32.365,96.332,96.332,0,0,0,12.375,28.557A65.815,65.815,0,0,0,736.123,985q13,7.943,32.681,7.933,36.173,0,59.018-33.634t22.846-97.093Q850.668,791.142,841.783,733.383ZM684.4,741.316q5.712-7.289,10.788-9.837a12.963,12.963,0,0,1,9.519-1.269,22.642,22.642,0,0,1,8.25,4.442q8.88,7.615,16.5,27.288-10.8-6.336-20.941-6.98a86.758,86.758,0,0,0-18.4.634,63.641,63.641,0,0,0-17.768,6.346Q678.682,748.614,684.4,741.316Z" />
                            </svg>
                            <svg id="exclamationMarkIcon" className="reactionIcon" viewBox="0 0 1000 1000">
                                <path d="M718.518,12.828c24.235,0.826,47.171,10.6,65.653,20.366,18.542,10.375,32.682,20.9,40.4,37.158,16.844,30.193,2.931,92.195-18.519,220.57-10.533,61.092-21.225,126.672-31.87,179.53-10.71,53.553-21.6,94.518-33.7,122.278-23.643,55.548-53.637,59.949-87.011,58.356-33.185-4.465-59.153-14.212-70.875-73.25-6.062-29.481-8.83-71.791-9.424-126.421-0.623-53.936.716-120.378,1.868-182.459,2.645-130.375,3.528-193.926,27.393-220.31,11.5-14.211,27.811-21.82,47.979-28.46,20.037-6.055,44.029-11.245,68.106-7.358M626.843,723.96A108.037,108.037,0,1,1,518.857,832,108.011,108.011,0,0,1,626.843,723.96ZM260.311,207.811c19.975-4.673,40.865-1.755,58.117,2.144,17.433,4.382,31.305,9.855,41.2,21.431,20.422,20.942,22.742,74.653,33.557,184.237,4.881,52.221,10.623,108.143,13.595,153.664,3.073,46.1,3.224,81.963-.539,107.308-7.051,50.587-30.577,60.8-58.187,66.867-28.088,3.678-51.449,1.448-74.053-44.184-11.458-22.74-23.058-56.686-35.6-101.173-12.413-43.915-25.984-98.476-38.745-149.435C173.041,341.6,159.736,289.5,173.4,262.687c6.258-14.146,17.9-23.96,32.905-33.834,15.029-9.368,33.479-18.9,54-21.042M342.39,808.858A91.4,91.4,0,1,1,278.038,920.93,91.382,91.382,0,0,1,342.39,808.858Z" />
                            </svg>
                            <svg
                                id="questionMarkIcon"
                                className="reactionIcon"
                                viewBox="0 0 700 600"
                                onMouseEnter={this.handleQuestionMarkEnter}
                                onMouseLeave={this.handleQuestionMarkLeave}
                            >
                                <path
                                    id="mark"
                                    className="cls-1"
                                    d="M341.283,367.012c1.15-27.187-3.316-55.473,15.311-76.554,21.378-24.194,67.3-59.605,69.408-102.071,1.566-31.485-21.264-65.964-58.18-73.491-18.017-3.673-40.86-1-59.611,14.637-24.586,20.51-34.294,51.91-34.294,81.31"
                                />
                                <circle id="dot" className="cls-2" cx="339.156" cy="478.25" r="47.969" />
                            </svg>
                        </div>
                    </div>
                ) : null}
                <ChatLabel text={`BlueBubbles Messaging with ${chatTitle}`} date={date} />

                {/* Reverse the list because we want to display it bottom to top */}
                {messages.map((message: Message, index: number) => {
                    let newerMessage = null;
                    let olderMessage = null;

                    // Get the surrounding messages (if available)
                    if (index - 1 >= 0 && index - 1 < messages.length) olderMessage = messages[index - 1];
                    if (index + 1 < messages.length && index + 1 >= 0) newerMessage = messages[index + 1];

                    let myNewMessages = [];
                    if (chat.participants.length <= 1 && index + 1 < messages.length) {
                        myNewMessages = messages.slice(index + 1, messages.length).filter(i => i.isFromMe);
                    }

                    return (
                        <div key={message.guid}>
                            {/* If the last previous message is older than 30 minutes, display the time */}
                            {message.text &&
                            olderMessage &&
                            message.dateCreated - olderMessage.dateCreated > 1000 * 60 * 5 ? (
                                <ChatLabel
                                    text={`${getDateText(new Date(message.dateCreated))}, ${getTimeText(
                                        new Date(message.dateCreated)
                                    )}`}
                                />
                            ) : null}
                            {/* If the message text is null, it's a group event */}
                            {message.text ? (
                                <ClickNHold
                                    time={0.8}
                                    onStart={this.start}
                                    onClickNHold={() => this.clickNHold(message)}
                                    onEnd={this.end}
                                >
                                    <MessageBubble
                                        chat={chat}
                                        message={message}
                                        olderMessage={olderMessage}
                                        newerMessage={newerMessage}
                                        showStatus={message.isFromMe && myNewMessages.length === 0}
                                    />
                                </ClickNHold>
                            ) : (
                                getChatEvent(message)
                            )}
                        </div>
                    );
                })}
            </div>
        );
    }
}

export default RightConversationDisplay;
