import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const { getAdConfig } = require("../../dev/config.js");
const ads = require("../../ads.json");
const banner = { on: vi.fn() };
const interstitial = { load: vi.fn().mockResolvedValue(), on: vi.fn() };

vi.mock("../../src/lib/bannerVisibilityController.mjs", () => ({
	BANNER_SUPPRESSION_REASON: {},
	bannerVisibilityController: { setBanner: vi.fn() },
}));
vi.mock("../../src/lib/config", () => ({ default: { HAS_PRO: false } }));

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("window", { ANDROID_SDK_INT: 0 });
	vi.stubGlobal("Bridge", { platformId: "ios" });
	vi.stubGlobal("BuildInfo", { buildType: "debug" });
	setBuildConstants("ios", "Debug");
	vi.stubGlobal("admob", {
		privacy: {
			gatherConsent: vi.fn().mockResolvedValue({
				consentStatus: "notRequired",
				canRequestAds: true,
			}),
		},
		start: vi.fn().mockResolvedValue(),
		configure: vi.fn().mockResolvedValue(),
		BannerAd: vi.fn(function () {
			return banner;
		}),
		InterstitialAd: vi.fn(function () {
			return interstitial;
		}),
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

test.each([
	["ios", "Debug"],
	["ios", "Release"],
	["android", "Debug"],
	["android", "Release"],
])("%s %s initializes after consent using its compiled IDs", async (platform, mode) => {
	setBuildConstants(platform, mode);
	window.ANDROID_SDK_INT = platform === "android" ? 29 : 0;
	const ids = getAdConfig(platform, mode);
	const { default: startAd, adUnitIdRewarded } = await import(
		"../../src/lib/startAd.js"
	);
	await startAd();
	expect(admob.privacy.gatherConsent).toHaveBeenCalledOnce();
	expect(admob.start).toHaveBeenCalledOnce();
	expect(admob.BannerAd).toHaveBeenCalledWith({
		adUnitId: ids.banner,
		position: "bottom",
	});
	expect(admob.InterstitialAd).toHaveBeenCalledWith({
		adUnitId: ids.interstitial,
	});
	expect(adUnitIdRewarded).toBe(ids.rewarded);
	expect(window.adRewardedUnitId).toBe(adUnitIdRewarded);
});

test("iOS does not initialize ads when consent is unavailable", async () => {
	admob.privacy.gatherConsent.mockResolvedValue({
		consentStatus: "required",
		canRequestAds: false,
	});
	const { default: startAd } = await import("../../src/lib/startAd.js");
	await startAd();
	expect(admob.start).not.toHaveBeenCalled();
	expect(admob.BannerAd).not.toHaveBeenCalled();
});

test("Android retains its existing test units and SDK version gate", async () => {
	setBuildConstants("android", "Debug");
	window.ANDROID_SDK_INT = 28;
	const { default: startAd } = await import("../../src/lib/startAd.js");
	await startAd();
	expect(admob.start).not.toHaveBeenCalled();
	window.ANDROID_SDK_INT = 29;
	await startAd();
	expect(admob.BannerAd).toHaveBeenCalledWith({
		adUnitId: "ca-app-pub-3940256099942544/6300978111",
		position: "bottom",
	});
	expect(window.adRewardedUnitId).toBe(
		"ca-app-pub-3940256099942544/5224354917",
	);
});

test.each([
	"",
	"invalid",
	"ca-app-pub-3940256099942544/2435281174",
])("release builds reject an invalid production ID: %s", (id) => {
	const original = ads.ios.production.banner;
	ads.ios.production.banner = id;
	try {
		expect(() => getAdConfig("ios", "Release")).toThrow(
			/Invalid ios banner ID/,
		);
	} finally {
		ads.ios.production.banner = original;
	}
});

test("runtime build metadata cannot replace compiled iOS production IDs", async () => {
	setBuildConstants("ios", "Release");
	Bridge.platformId = "android";
	const { default: startAd } = await import("../../src/lib/startAd.js");
	await startAd();
	expect(admob.BannerAd).toHaveBeenCalledWith({
		adUnitId: ads.ios.production.banner,
		position: "bottom",
	});
});

function setBuildConstants(platform, mode) {
	const ids = getAdConfig(platform, mode);
	vi.stubGlobal("IS_IOS", platform === "ios");
	vi.stubGlobal("IS_ANDROID", platform === "android");
	vi.stubGlobal("PLATFORM", platform);
	vi.stubGlobal("ADMOB_BANNER_ID", ids.banner);
	vi.stubGlobal("ADMOB_INTERSTITIAL_ID", ids.interstitial);
	vi.stubGlobal("ADMOB_REWARDED_ID", ids.rewarded);
}
