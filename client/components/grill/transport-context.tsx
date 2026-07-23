import { createContext, useContext } from "react";
import type { AcpChatTransport } from "@/hooks/acp-chat-transport";

export const GrillTransportContext = createContext<AcpChatTransport | null>(null);

export function useGrillTransport(): AcpChatTransport | null {
  return useContext(GrillTransportContext);
}
