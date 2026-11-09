/**
 * Enhanced Chat v2, signed in as the patient.
 *
 * Enhanced Chat is Salesforce's own chat window: the Agentforce Voice button
 * in it only exists there, which is why the portal embeds it instead of
 * drawing its own chat. This component loads the deployment's bootstrap.js,
 * then proves who the patient is before the first message:
 *
 *   1. POST /portal/chat-token (as the signed-in patient) returns the chat's
 *      settings and a short-lived JWT whose sub is the patient's User Id.
 *   2. On onEmbeddedMessagingReady, userVerificationAPI.setIdentityToken
 *      hands Messaging that JWT. Messaging checks it against the keyset that
 *      holds the signing certificate's public key, so the conversation is a
 *      verified one, and the Patient Portal Agent's actions read only this
 *      patient's account (PortalIdentityService.forMessagingSession).
 *   3. When the token expires mid-chat, Messaging fires
 *      onEmbeddedMessagingIdentityTokenExpired and a fresh one is set.
 *   4. On sign-out, clearSession ends the verified session in this browser.
 *
 * Renders nothing itself: the chat button is injected by bootstrap.js.
 */
import { useEffect } from "react";
import { startChat, type ChatStart } from "../api/portal/portalApi";
import type { WindowWithCwcProperties } from "../types/chat";

interface PatientChatProps {
	/** Only a signed-in patient gets a chat. */
	signedIn: boolean;
	language?: string;
	onUnavailable?: (message: string) => void;
}

export function PatientChat({ signedIn, language = "en_US", onUnavailable }: PatientChatProps) {
	useEffect(() => {
		if (!signedIn || typeof window === "undefined") return;
		const win = window as WindowWithCwcProperties;
		let cancelled = false;

		const setToken = (chat: ChatStart) => {
			if (chat.token && win.embeddedservice_bootstrap) {
				win.embeddedservice_bootstrap.userVerificationAPI.setIdentityToken({
					identityTokenType: "JWT",
					identityToken: chat.token,
				});
			}
		};
		let first: ChatStart | null = null;
		const onReady = () => {
			// The token fetched to start the chat, unless it is about to expire.
			if (first?.expiresAt && first.expiresAt * 1000 > Date.now() + 30_000) {
				setToken(first);
				return;
			}
			startChat().then((fresh) => !cancelled && setToken(fresh));
		};
		const onExpired = () => {
			startChat().then((fresh) => !cancelled && setToken(fresh));
		};

		startChat()
			.then((chat) => {
				if (cancelled) return;
				first = chat;
				if (!chat.enabled || !chat.orgId || !chat.deploymentName || !chat.siteUrl || !chat.scrtUrl) {
					onUnavailable?.(chat.message ?? "The care assistant is not available right now.");
					return;
				}
				window.addEventListener("onEmbeddedMessagingReady", onReady);
				window.addEventListener("onEmbeddedMessagingIdentityTokenExpired", onExpired);

				const init = () => {
					const bootstrap = win.embeddedservice_bootstrap;
					if (!bootstrap) return;
					bootstrap.settings.language = language;
					bootstrap.init(chat.orgId!, chat.deploymentName!, chat.siteUrl!, { scrt2URL: chat.scrtUrl! });
				};
				const src = `${chat.siteUrl}/assets/js/bootstrap.min.js`;
				const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
				if (existing) {
					if (win.embeddedservice_bootstrap) init();
					else existing.addEventListener("load", init, { once: true });
					return;
				}
				const script = document.createElement("script");
				script.type = "text/javascript";
				script.src = src;
				script.addEventListener("load", init, { once: true });
				document.body.appendChild(script);
			})
			.catch(() => !cancelled && onUnavailable?.("The care assistant is not available right now."));

		return () => {
			cancelled = true;
			window.removeEventListener("onEmbeddedMessagingReady", onReady);
			window.removeEventListener("onEmbeddedMessagingIdentityTokenExpired", onExpired);
		};
	}, [signedIn, language, onUnavailable]);

	return null;
}

/** Ends the verified chat session in this browser; call before signing out. */
export async function endPatientChat(): Promise<void> {
	const win = window as WindowWithCwcProperties;
	try {
		await win.embeddedservice_bootstrap?.userVerificationAPI.clearSession();
	} catch {
		/* no chat was started */
	}
}

export default PatientChat;
