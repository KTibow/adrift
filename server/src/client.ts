import { IncomingMessage, STATUS_CODES } from "http";

import EventEmitter from "events";

import {
  C2SRequestTypes,
  HTTPRequestPayload,
  HTTPResponsePayload,
  ProtoBareHeaders,
  S2CRequestTypes,
} from "protocol";
import { Readable } from "stream";
import { BareError, bareFetch, options } from "./http";

export class Client {
  send: (msg: Buffer) => void;
  events: EventEmitter;

  constructor(send: (msg: Buffer) => void) {
    this.send = send;
    this.events = new EventEmitter();
  }

  static parseMsgInit(
    msg: Buffer
  ): { cursor: number; seq: number; op: number } | undefined {
    try {
      let cursor = 0;
      const seq = msg.readUint16BE(cursor);
      cursor += 2;
      const op = msg.readUint8(cursor);
      cursor += 1;
      return { cursor, seq, op };
    } catch (e) {
      if (e instanceof RangeError) {
        // malformed message
        return;
      }
      throw e;
    }
  }

  static parseHttpReqPayload(
    payloadRaw: Buffer
  ): HTTPRequestPayload | undefined {
    let payload;
    try {
      payload = JSON.parse(payloadRaw.toString());
    } catch (e) {
      if (e instanceof SyntaxError) {
        return;
      }
      throw e;
    }
    console.log({ payload });
    return payload;
  }

  static bareErrorToResponse(e: BareError): {
    payload: HTTPResponsePayload;
    body: AsyncIterable<Buffer>;
  } {
    return {
      payload: {
        status: e.status,
        statusText: STATUS_CODES[e.status] || "",
        headers: {},
      },
      body: Readable.from(JSON.stringify(e.body)),
    };
  }

  async handleHTTPRequest(payload: HTTPRequestPayload): Promise<{
    payload: HTTPResponsePayload;
    body: AsyncIterable<Buffer>;
  }> {
    const abort = new AbortController();
    const onClose = () => {
      abort.abort();
      this.events.off("close", onClose);
    };
    this.events.on("close", onClose);

    let resp: IncomingMessage;
    try {
      resp = await bareFetch(
        payload,
        abort.signal,
        new URL(payload.remote),
        options
      );
    } catch (e) {
      if (e instanceof BareError) {
        return Client.bareErrorToResponse(e);
      }
      this.events.off("close", onClose);
      throw e;
    }

    this.events.off("close", onClose);

    return {
      payload: {
        status: resp.statusCode || 500,
        statusText: resp.statusMessage || "",
        headers: Object.fromEntries(
          Object.entries(resp.headersDistinct).filter(([_k, v]) => Boolean(v))
        ) as ProtoBareHeaders,
      },
      body: resp,
    };
  }

  sendHTTPResponseStart(seq: number, payload: HTTPResponsePayload) {
    const payloadBuffer = Buffer.from(JSON.stringify(payload));
    const buf = Buffer.alloc(2 + 1 + payloadBuffer.length);
    let cursor = 0;
    cursor = buf.writeUInt16BE(seq, cursor);
    cursor = buf.writeUInt8(S2CRequestTypes.HTTPResponseStart, cursor);
    payloadBuffer.copy(buf, cursor);
    this.send(buf);
  }

  sendHTTPResponseChunk(seq: number, chunk: Buffer) {
    const buf = Buffer.alloc(2 + 1 + chunk.length);
    let cursor = 0;
    cursor = buf.writeUInt16BE(seq, cursor);
    cursor = buf.writeUInt8(S2CRequestTypes.HTTPResponseChunk, cursor);
    chunk.copy(buf, cursor);
    this.send(buf);
  }

  sendHTTPResponseEnd(seq: number) {
    const buf = Buffer.alloc(2 + 1);
    let cursor = 0;
    cursor = buf.writeUInt16BE(seq, cursor);
    cursor = buf.writeUInt8(S2CRequestTypes.HTTPResponseEnd, cursor);
    this.send(buf);
  }

  async onMsg(msg: Buffer) {
    const init = Client.parseMsgInit(msg);
    if (!init) return;
    const { cursor, seq, op } = init;
    switch (op) {
      case C2SRequestTypes.HTTPRequest:
        let resp: {
          payload: HTTPResponsePayload;
          body: AsyncIterable<Buffer>;
        };
        const reqPayload = Client.parseHttpReqPayload(msg.subarray(cursor));
        if (!reqPayload) return;
        try {
          resp = await this.handleHTTPRequest(reqPayload);
        } catch (e) {
          if (options.logErrors) console.error(e);

          let bareError;
          if (e instanceof BareError) {
            bareError = e;
          } else if (e instanceof Error) {
            bareError = new BareError(500, {
              code: "UNKNOWN",
              id: `error.${e.name}`,
              message: e.message,
              stack: e.stack,
            });
          } else {
            bareError = new BareError(500, {
              code: "UNKNOWN",
              id: "error.Exception",
              message: "Error: " + e,
              stack: new Error(<string | undefined>e).stack,
            });
          }

          resp = Client.bareErrorToResponse(bareError);
        }

        const { payload, body } = resp;
        this.sendHTTPResponseStart(seq, payload);
        for await (const chunk of body) {
          this.sendHTTPResponseChunk(seq, chunk);
        }
        this.sendHTTPResponseEnd(seq);
        break;
      default:
        // not implemented
        break;
    }
  }

  onClose() {
    this.events.emit("close");
  }
}
