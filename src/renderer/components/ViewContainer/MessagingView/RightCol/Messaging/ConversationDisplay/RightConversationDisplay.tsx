/* eslint-disable class-methods-use-this */
import * as React from "react";
import { ipcRenderer } from "electron";
import { Chat, Message as DBMessage } from "@server/databases/chat/entity";
import { getDateText, getTimeText } from "@renderer/helpers/utils";
import { ValidTapback } from "@server/types";

import "./RightConversationDisplay.css";
import ChatLabel from "./ChatLabel";
import MessageBubble from "./MessageBubble";

type Props = {
    chat: Chat;
};

type State = {
    isLoading: boolean;
    messages: Message[];
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
            messages: []
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
        const messages: DBMessage[] = await ipcRenderer.invoke("get-messages", {
            chatGuid: this.props.chat.guid,
            withHandle: true,
            withAttachments: true,
            withChat: false,
            limit: 50,
            after: 1,
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
                            message.dateCreated - olderMessage.dateCreated > 1000 * 60 * 60 ? (
                                <ChatLabel
                                    text={`${getDateText(new Date(message.dateCreated), true)}, ${getTimeText(
                                        new Date(message.dateCreated)
                                    )}`}
                                />
                            ) : null}
                            {/* If the message text is null, it's a group event */}
                            {message.text ? (
                                <>
                                    <MessageBubble
                                        chat={chat}
                                        message={message}
                                        olderMessage={olderMessage}
                                        newerMessage={newerMessage}
                                        showStatus={message.isFromMe && myNewMessages.length === 0}
                                        messages={messages}
                                    />
                                </>
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
