// Dev-only module shims for soft-optional peers absent from a bare checkout.
// The runtime guards these imports (dynamic import + catch); the shims exist
// purely so `tsc --noEmit` can type-check the rest of the package. `any`
// shapes keep the `as I18nLoader` / `as I18nSDK` casts unchecked, matching
// the runtime reality that these modules may not exist at all.
declare module "@juicesharp/rpiv-i18n/loader" {
	const loader: any;
	export = loader;
}
declare module "@juicesharp/rpiv-i18n" {
	const sdk: any;
	export = sdk;
}
