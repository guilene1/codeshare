import { createContext, useContext } from "react";
import { api, setCsrfToken } from "./lib";

export type User = {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
};
export type AuthState = {
  user: User | null;
  ready: boolean;
  signedIn: (user: User, csrfToken: string) => void;
  signOut: () => Promise<void>;
  update: (user: User) => void;
};
export const AuthContext = createContext<AuthState>({
  user: null,
  ready: false,
  signedIn: () => {},
  signOut: async () => {},
  update: () => {},
});
export const useAuth = () => useContext(AuthContext);
export async function loadSession() {
  const me = await api<{ user: User | null; csrfToken?: string }>("/auth/me");
  setCsrfToken(me.csrfToken);
  return me.user;
}
