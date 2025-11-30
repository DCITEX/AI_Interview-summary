// /// <reference types="vite/client" />
// The reference to vite/client is commented out because the type definition file could not be found.
// This resolves the TS2688 error.

// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
