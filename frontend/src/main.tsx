import { createRoot } from "react-dom/client";
import App from "./App";
import UpdateNotice from "./components/UpdateNotice";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <UpdateNotice />
  </>,
);
