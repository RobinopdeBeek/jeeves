import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Board } from "./components/Board";
import { CardView } from "./components/CardView";
import { ChatPage } from "./components/ChatPage";
import { FilesPage } from "./components/FilesPage";
import { ServerConnectionBanner } from "./components/ServerConnectionBanner";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ROOT_REDIRECT_TO } from "./lib/app-routes";
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
    <TooltipProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route element={<AppShell />}>
              <Route path="/board" element={<Board />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/files" element={<FilesPage />} />
            </Route>
            <Route path="/cards/:id" element={<CardView />} />
            <Route path="/" element={<Navigate to={ROOT_REDIRECT_TO} replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster position="top-right" />
    </TooltipProvider>
  </React.StrictMode>,
);
