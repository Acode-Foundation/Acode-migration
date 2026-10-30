import { fromArrayBuffer, toArrayBuffer } from "./base64";

export type NativeCallback = ((...values: any[]) => void) | null | undefined;
export type NativeExec = (
	success: NativeCallback,
	error: NativeCallback,
	service: string,
	action: string,
	args?: unknown[],
) => void;
export interface NativeReply {
	id: number;
	keep?: boolean;
	status: number;
	data?: unknown;
}
export type NativeSender = (
	service: string,
	action: string,
	args: string,
	id: number,
) => boolean | void;

/** Bind a service once, then call its actions through the shared native transport. */
export default function bridge(service: string) {
	const exec = (
		success: NativeCallback,
		error: NativeCallback,
		action: string,
		args: unknown[] = [],
	) => Bridge.exec(success, error, service, action, args);
	const call = <T = void>(action: string, args: unknown[] = []): Promise<T> =>
		new Promise((resolve, reject) => exec(resolve, reject, action, args));
	return Object.assign(call, { exec });
}

export function createTransport(send: NativeSender) {
	const callbacks = new Map<
		number,
		{
			success: NativeCallback;
			error: NativeCallback;
			service: string;
			action: string;
		}
	>();
	let callbackId = 0;
	const exec: NativeExec = (success, error, service, action, args = []) => {
		const id = ++callbackId;
		callbacks.set(id, { success, error, service, action });
		try {
			const encoded = args.map((value) =>
				Object.prototype.toString.call(value) === "[object ArrayBuffer]"
					? fromArrayBuffer(value as ArrayBuffer)
					: value,
			);
			if (send(service, action, JSON.stringify(encoded), id) === false)
				throw new Error(`Native service rejected ${service}.${action}`);
		} catch (exception) {
			callbacks.delete(id);
			if (error)
				error(
					exception instanceof Error ? exception.message : String(exception),
				);
			else throw exception;
		}
	};
	const receive = ({ id, keep, status, data }: NativeReply) => {
		const callback = callbacks.get(id);
		if (!callback) return;
		if (!keep) callbacks.delete(id);
		if (status === 0) return;
		const payload = data as { kind?: string; data?: unknown[] } | undefined;
		const values =
			payload?.kind === "multipart"
				? payload.data!.map(decode)
				: [decode(data)];

		if (status === 1) {
			callback.success?.(...values);
			return;
		}

		// Never surface a bare action name: augment it with context so the user
		// and the logs can tell which native call actually failed.
		const failure = describeNativeFailure(
			callback.service,
			callback.action,
			values,
		);
		callback.error?.(failure, ...values.slice(1));
	};
	return { exec, receive };
}

function describeNativeFailure(
	service: string,
	action: string,
	values: unknown[],
): unknown {
	const raw = values[0];
	// Structured error payloads (HTTP responses, results objects) carry data the
	// callers consume, so only textual errors may be rewritten.
	if (raw != null && typeof raw !== "string") return raw;

	const message = typeof raw === "string" ? raw.trim() : "";
	if (!message) {
		return `${service}.${action} failed without an error message`;
	}
	if (message === action || message === `${service}.${action}`) {
		return `${service}.${action} is not handled by the app`;
	}
	return raw;
}

function decode(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const payload = value as { kind?: string; data: string };
	if (payload.kind === "binaryString") return atob(payload.data);
	if (payload.kind === "arrayBuffer") return toArrayBuffer(payload.data);
	return value;
}
