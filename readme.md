# Acode - Code Editor for Android

<p align="center">
  <img src='res/logo_1.png' width='250'>
</p>

[![](https://img.shields.io/endpoint?logo=telegram&label=Acode&style=flat&url=https%3A%2F%2Facode.app%2Fapi%2Ftelegram-members-count)](https://t.me/foxdebug_acode) [![](https://dcbadge.vercel.app/api/server/vVxVWYUAWD?style=flat)](https://discord.gg/vVxVWYUAWD)

## • Overview

Welcome to Acode Editor - a powerful and versatile code editing tool designed specifically for Android devices. Whether you're working on HTML, CSS, JavaScript, or other programming languages, Acode empowers you to code on-the-go with confidence.

Acode runs in an Android WebView with its own native service bridge. Android sources are tracked directly; native integrations are vendored and built with Java 26, the Gradle 9.8 RC3 wrapper and Android Gradle Plugin 9.4.1. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and build commands.

An iOS port is in progress using the same editor and plugin APIs with Swift native services. It is not release-ready; current coverage and remaining features are tracked in [docs/ios-port.md](docs/ios-port.md).

## • Features

- Edit and create websites, and instantly preview them in a browser.
- Seamlessly modify source files for various languages like Python, Java, JavaScript, and more.
- Built-in javascript console
- S/FTP and SSH terminal integration
- Built-in terminal (Ubuntu)
- Enjoy multi-language editing support with easy management tools.
- Enjoy a large collections of community plugins to enhance your coding experience.

## • Installation

You can get Acode Editor from popular platforms:

[<img src="https://play.google.com/intl/en_us/badges/images/generic/en-play-badge.png" alt="Get it on Google Play" height="60">](https://play.google.com/store/apps/details?id=com.foxdebug.acodefree) [<img src="https://fdroid.gitlab.io/artwork/badge/get-it-on.png" alt="Get it on F-Droid" height="60"/>](https://www.f-droid.org/packages/com.foxdebug.acode/)

## • Project Structure

<pre>
Acode/
|
|- src/   - Application source, index.html, language files, and resources
|
|- platforms/android/ - Native Android app, services, resources, and Gradle wrapper
|
|- platforms/ios/ - iOS app, runner/lib native services, and simulator tests
|- src/platforms/ - Android and iOS bridge transports
|- src/native/ - TypeScript native APIs and shared bridge
|
|- dev/ - CLI tools for building, string manipulation, and more
|
|- codemirror-lsp-client/ - Git submodule providing @codemirror/lsp-client (clone with --recurse-submodules)
</pre>

As in the Proteus template, web sources live in `src/`. Rspack generates
`platforms/android/app/src/main/assets/bundle/` or `platforms/ios/runner/bundle/`;
these ignored directories contain the HTML, static assets, and compiled scripts.

## • Multi-language Support

Enhance Acode's capabilities by adding new languages easily. Just create a file with the language code (e.g., en-us for English) in [`src/lang/`](https://github.com/Acode-Foundation/Acode/tree/main/src/lang) and include it in [`src/lib/lang.js`](https://github.com/Acode-Foundation/Acode/blob/main/src/lib/lang.js). Manage strings across languages effortlessly using utility commands:

```shell
pnpm run lang add
pnpm run lang remove
pnpm run lang search
pnpm run lang update
```

## • Contributing & Building the Application

Build scripts live in `dev/`. For Android, set `package.json.androidPackageId` to `com.foxdebug.acode` (paid) or `com.foxdebug.acodefree` (free), then run `npm run build -- dev apk`. Paid builds exclude AdMob and its SDKs. iOS has one free app whose bundle ID comes from `package.json.appleAppId`, using the `runner` scheme. Its build commands and advertising configuration are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

For iOS, copy `platforms/ios/Config.xcconfig.example` to `platforms/ios/Config.xcconfig` on a new checkout. Keep only local signing settings in this ignored file. Version, build number, display name and bundle ID are synced into the Xcode project from `package.json` by `dev/sync.js` on every build.

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions.

## • Contributors

<a href="https://github.com/Acode-Foundation/Acode/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Acode-Foundation/Acode" />
</a>

## • Developing a Plugin for Acode

For comprehensive documentation on creating plugins for Acode Editor, visit the [repository](https://github.com/Acode-Foundation/acode-plugin).

For plugin development information, refer to: [Acode Plugin Documentation](https://docs.acode.app/)

## Star History

<a href="https://star-history.com/#Acode-Foundation/Acode&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Acode-Foundation/Acode&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Acode-Foundation/Acode&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Acode-Foundation/Acode&type=Date" />
 </picture>
</a>

The iOS terminal uses an ARM64 Alpine emulator with the existing terminal UI and AXS server. See [runtime sources, build requirements, and compatibility limits](platforms/ios/Alpine/README.md).
