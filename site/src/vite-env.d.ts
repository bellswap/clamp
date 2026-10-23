/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_BELL_URL?: string;
  readonly VITE_BOOK_JSON?: string;
  readonly VITE_MOCK?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
