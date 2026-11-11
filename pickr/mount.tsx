// Dev-only entry: injected into the page by the `pickr-dev` Vite plugin (vite.config.ts).
import { createRoot } from "react-dom/client";
import Pickr from "./Pickr";

if (process.env.NODE_ENV !== "production") {
  const host = document.createElement("div");
  host.setAttribute("data-pickr", "");
  document.body.appendChild(host);
  createRoot(host).render(<Pickr />);
}
