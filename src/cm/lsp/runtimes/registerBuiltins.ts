import { registerRuntimeProvider } from "../runtimeProviders";
import builtinUbuntuRuntimeProvider from "./builtinUbuntu";
import externalWebSocketRuntimeProvider from "./externalWebSocket";
import webWorkerRuntimeProvider from "./webWorker";

if (platform.localExecution)
	registerRuntimeProvider(builtinUbuntuRuntimeProvider, { replace: true });
registerRuntimeProvider(externalWebSocketRuntimeProvider, { replace: true });
registerRuntimeProvider(webWorkerRuntimeProvider, { replace: true });
import platform from "lib/platform";
