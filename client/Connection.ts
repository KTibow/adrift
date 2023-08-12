import {
  C2SRequestType,
  C2SRequestTypes,
  HTTPRequestPayload,
  S2CRequestType,
  S2CRequestTypes,
} from "../protocol";
import Transport from "./Transport";

export default class Connection {
  callbacks: Record<number, Function> = {};

  counter: number = 0;

  constructor(public transport: Transport) {
    transport.ondata = this.ondata.bind(this);
  }

  ondata(data: ArrayBuffer) {
    let cursor = 0;
    const view = new DataView(data);

    let requestID = view.getUint16(cursor);
    cursor += 2;
    let requestType = view.getUint8(cursor) as S2CRequestType;
    cursor += 1;

    console.log(requestID, requestType);

    switch (requestType) {
      case S2CRequestTypes.HTTPResponse: {
        let decoder = new TextDecoder();
        let text = decoder.decode(data.slice(cursor));
        console.log(text);
        let json = JSON.parse(text);

        console.log(requestID);

        this.callbacks[requestID](json);
        break;
      }
    }
  }

  async send(
    requestID: number,
    data: ArrayBuffer | Blob,
    type: C2SRequestType
  ): Promise<void> {
    let header = new ArrayBuffer(2 + 1);
    let view = new DataView(header);

    let cursor = 0;

    view.setUint16(cursor, requestID);
    cursor += 2;
    view.setUint8(cursor, type);
    cursor += 1;

    let buf = await new Blob([header, data]).arrayBuffer();

    this.transport.send(buf);
    console.log(buf);
  }

  httprequest(data: HTTPRequestPayload): Promise<object> {
    let json = JSON.stringify(data);

    return new Promise(async (resolve) => {
      let id = ++this.counter;
      this.callbacks[id] = resolve;
      await this.send(id, new Blob([json]), C2SRequestTypes.HTTPRequest);
    });
  }
}
