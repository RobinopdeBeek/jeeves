import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";
import { Board } from "./components/Board";
import { CardView } from "./components/CardView";
import { ServerConnectionBanner } from "./components/ServerConnectionBanner";
import { ServerConnectionProvider } from "./lib/server-connection";
import "./globals.css";

function AppLayout() {
  return (
    <ServerConnectionProvider>
      <ServerConnectionBanner />
      <Outlet />
    </ServerConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Board />} />
          <Route path="/cards/:id" element={<CardView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
