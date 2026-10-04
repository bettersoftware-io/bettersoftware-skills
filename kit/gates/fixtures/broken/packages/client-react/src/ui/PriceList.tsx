import { BehaviorSubject } from "rxjs";
import { bind } from "@react-rxjs/core";

import { startApp } from "../app/startApp.ts";
import { createWsPrice } from "@fx/client-core/adapters/wsPrice.ts";

const saved = localStorage.getItem("prices");
const source = import.meta.env.VITE_PRICE_SOURCE;
const timer = setTimeout(() => {}, 300);

export const PriceList = [BehaviorSubject, bind, startApp, createWsPrice, saved, source, timer];
