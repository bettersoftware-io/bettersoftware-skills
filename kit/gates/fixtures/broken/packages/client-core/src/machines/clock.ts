import { hostname } from "node:os";
import { WebSocketServer } from "ws";
import { connect } from "ws-extra";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

export const clock = [hostname, WebSocketServer, connect, Hono, serve];
