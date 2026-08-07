import { mount } from "svelte";
import App from "./App.svelte";
import "../styles/reset.css";
import "../styles/global.css";
import "./playground.css";
import "./filerow.css";
import "./logrow.css";
import "./preview.css";

mount(App, { target: document.getElementById("app") });
