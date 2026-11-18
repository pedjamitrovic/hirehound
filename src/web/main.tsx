import { render } from "preact";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/screens.css";
import "./styles/profile.css";
import "./styles/forms.css";
import "./styles/review.css";
import "./styles/apply.css";
import "./styles/sources.css";
import "./state/theme.ts";
import { App } from "./app.tsx";

const root = document.getElementById("app");
if (root) render(<App />, root);
