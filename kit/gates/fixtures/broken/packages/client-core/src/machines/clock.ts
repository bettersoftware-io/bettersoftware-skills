import { hostname } from "node:os";
import { WebSocketServer } from "ws";
import { connect } from "ws-extra";

export const clock = [hostname, WebSocketServer, connect];
