import { PhoneNumberUtil } from "google-libphonenumber";
import { Chat } from "@server/databases/chat/entity";

export const getTimeText = (date: Date) => {
    return date.toLocaleString("en-US", { hour: "numeric", minute: "numeric", hour12: true });
};

export const getDateText = (date: Date) => {
    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const nowLocale = now.toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
    const msgLocale = date.toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
    const yLocale = yesterday.toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric" });

    if (nowLocale === msgLocale) return getTimeText(date);
    if (yLocale === msgLocale) return "Yesterday";
    return date.toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric" }).slice(0, -2);
};

export const getiMessageNumberFormat = (address: string) => {
    if (!address) return address;

    // If it's an email, just return the email
    if (address.includes("@")) return address;

    const phoneUtil = PhoneNumberUtil.getInstance();
    const number = phoneUtil.parseAndKeepRawInput(address, "US");
    const formatted = phoneUtil.formatOutOfCountryCallingNumber(number, "US");
    return `+${formatted}`;
};

export const getContact = (address: string) => {
    return null;
};

export const getFullName = (contact: any) => {
    return contact;
};

export const generateChatTitle = (chat: Chat) => {
    if (!chat) return "";
    if (chat.displayName) return chat.displayName;

    const members = [];
    for (const i of chat.participants) {
        const contact = getContact(i.address);
        if (!contact) {
            members.push(getiMessageNumberFormat(i.address));
        } else if (chat.participants.length === 1) {
            members.push(getFullName(contact));
        } else {
            members.push(contact); // TODO: Only get first name
        }
    }

    if (members.length === 0) return chat.chatIdentifier;
    if (members.length === 1) return members[0];
    if (members.length <= 4) {
        const title = members.join(", ");
        const idx = title.lastIndexOf(", ");
        return idx === -1 ? title : `${title.substring(0, idx)} & ${title.substring(idx + 2)}`;
    }

    const title = members.slice(0, 3).join(", ");
    return `${title} & ${members.length - 3} others`;
};

export const sanitizeStr = (val: string) => {
    if (!val) return val;
    const objChar = String.fromCharCode(65532);

    // Recursively replace all "obj" hidden characters
    let output = val;
    while (output.includes(objChar)) {
        output = output.replace(String.fromCharCode(65532), "");
    }

    return output.trim();
};