import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Board } from "./components/Board";
import { CardView } from "./components/CardView";
import "./globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Board />} />
        <Route path="/cards/:id" element={<CardView />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
