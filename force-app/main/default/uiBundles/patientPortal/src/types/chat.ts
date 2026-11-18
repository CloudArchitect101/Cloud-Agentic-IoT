/**
 * The parts of the Enhanced Chat (Embedded Messaging) bootstrap global that
 * the portal uses. bootstrap.js comes from the deployment's site URL.
 */
export interface EmbeddedServiceBootstrap {
	settings: {
		language: string;
		devMode?: boolean;
	};
	init: (orgId: string, deploymentName: string, siteURL: string, options: { scrt2URL: string }) => void;
	userVerificationAPI: {
		setIdentityToken: (token: { identityTokenType: "JWT"; identityToken: string }) => void;
		clearSession: () => Promise<void> | void;
	};
}

export interface WindowWithCwcProperties extends Window {
	embeddedservice_bootstrap?: EmbeddedServiceBootstrap;
}
