import "./styles/app.css";
import "./styles/editor.css";
import "./styles/components.css";
import "./styles/canvas.css";
import "./styles/graph.css";
import { App } from "./app/app";
import { installAndroidInsets } from "./ui/android-insets";

installAndroidInsets();
const app = new App(document.getElementById("app")!);
void app.start();
