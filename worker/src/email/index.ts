import { Context } from "hono";

import { getBooleanValue, getJsonSetting } from "../utils";
import { sendMailToTelegram } from "../telegram_api";
import { auto_reply } from "./auto_reply";
import { isBlocked } from "./black_list";
import { triggerWebhook, triggerAnotherWorker, commonParseMail } from "../common";
import { check_if_junk_mail } from "./check_junk";
import { remove_attachment_if_need } from "./check_attachment";
import { extractEmailInfo } from "./ai_extract";
import { forwardEmail } from "./forward";
import { EmailRuleSettings } from "../models";
import { CONSTANTS } from "../constants";
import { compressText } from "../gzip";
import { getStoredOriginalRecipient } from "./original_recipient";
import { insertRawMail } from "./raw_mail_storage";


async function email(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext) {
    if (await isBlocked(message.from, env)) {
        message.setReject("Reject from address");
        console.log(`Reject message from ${message.from} to ${message.to}`);
        return;
    }
    const rawEmail = await new Response(message.raw).text();
    const parsedEmailContext: ParsedEmailContext = {
        rawEmail: rawEmail
    };

    // check if junk mail
    try {
        const is_junk = await check_if_junk_mail(env, message.to, parsedEmailContext, message.headers.get("Message-ID"));
        if (is_junk) {
            message.setReject("Junk mail");
            console.log(`Junk mail from ${message.from} to ${message.to}`);
            return;
        }
    } catch (error) {
        console.error("check junk mail error", error);
    }

    // check if unknown address mail
    try {
        const emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
            { env: env } as Context<HonoCustomType>, CONSTANTS.EMAIL_RULE_SETTINGS_KEY
        );
        if (emailRuleSettings?.blockReceiveUnknowAddressEmail) {
            const db_address_id = await env.DB.prepare(
                `SELECT id FROM address where name = ? `
            ).bind(message.to).first("id");
            if (!db_address_id) {
                message.setReject("Unknown address");
                console.log(`Unknown address mail from ${message.from} to ${message.to}`);
                return;
            }
        }
    } catch (error) {
        console.error("check unknown address mail error", error);
    }

    // remove attachment if configured or size > 2MB
    try {
        await remove_attachment_if_need(env, parsedEmailContext, message.from, message.to, message.rawSize);
    } catch (error) {
        console.error("remove attachment error", error);
    }

    const message_id = message.headers.get("Message-ID");
    const originalRecipient = getStoredOriginalRecipient({
        address: message.to,
        source: message.from,
        rawEmail: parsedEmailContext.rawEmail,
        headers: message.headers,
    }) || null;
    // save email
    try {
        let success = false;
        if (getBooleanValue(env.ENABLE_MAIL_GZIP)) {
            let compressed: ArrayBuffer | null = null;
            try {
                compressed = await compressText(parsedEmailContext.rawEmail);
            } catch (gzipError) {
                console.error("gzip compression failed, falling back to plaintext", gzipError);
            }
            if (compressed) {
                success = await insertRawMail({
                    db: env.DB,
                    source: message.from,
                    address: message.to,
                    raw: parsedEmailContext.rawEmail,
                    rawBlob: compressed,
                    messageId: message_id,
                    originalRecipient,
                });
            } else {
                success = await insertRawMail({
                    db: env.DB,
                    source: message.from,
                    address: message.to,
                    raw: parsedEmailContext.rawEmail,
                    messageId: message_id,
                    originalRecipient,
                });
            }
        } else {
            success = await insertRawMail({
                db: env.DB,
                source: message.from,
                address: message.to,
                raw: parsedEmailContext.rawEmail,
                messageId: message_id,
                originalRecipient,
            });
        }
        if (!success) {
            message.setReject(`Failed save message to ${message.to}`);
            console.error(`Failed save message from ${message.from} to ${message.to}`);
        }
    }
    catch (error) {
        console.error("save email error", error);
    }

    // forward email
    await forwardEmail(message, env);

    // send email to telegram
    try {
        await sendMailToTelegram(
            { env: env } as Context<HonoCustomType>,
            message.to, parsedEmailContext, message_id);
    } catch (error) {
        console.error("send mail to telegram error", error);
    }

    // send webhook
    try {
        await triggerWebhook(
            { env: env } as Context<HonoCustomType>,
            message.to, parsedEmailContext, message_id
        );
    } catch (error) {
        console.error("send webhook error", error);
    }

    // trigger another worker
    try {
        const parsedEmail = (await commonParseMail(parsedEmailContext));
        const parsedText = parsedEmail?.text ?? ""
        const rpcEmail: RPCEmailMessage = {
            from: message.from,
            to: message.to,
            rawEmail: rawEmail,
            headers: message.headers
        }
        await triggerAnotherWorker({ env: env } as Context<HonoCustomType>, rpcEmail, parsedText);
    } catch (error) {
        console.error("trigger another worker error", error);
    }

    // auto reply email
    await auto_reply(message, env);

    // AI email content extraction
    await extractEmailInfo(parsedEmailContext, env, message_id, message.to);
}

export { email }
