import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SnippetsApp from "./SnippetsApp";
import "./styles.css";

// Route on the URL hash. Tauri opens the snippets window with
// `index.html#/snippets`; everything else is the main popup.
const isSnippetsWindow =
  typeof window !== "undefined" && window.location.hash.startsWith("#/snippets");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isSnippetsWindow ? <SnippetsApp /> : <App />}</React.StrictMode>
);
