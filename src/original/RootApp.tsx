import { useState } from "react";
import { App } from "../ui/App";
import { OriginalApp } from "./OriginalApp";
import type { IncomingFile } from "./OriginalApp";
import { appBasePath } from "../pwa/base";
export function RootApp() {
  const [original, setOriginal] = useState(
    () => { const query = new URLSearchParams(location.search); return query.get("view") === "original" || !query.has("view") && !query.has("mode") && appBasePath() !== "/"; },
  );
  const [file, setFile] = useState<IncomingFile | undefined>();
  return original ? (
    <OriginalApp initialFile={file} onFileRead={() => setFile(undefined)} />
  ) : (
    <App
      onOriginalImport={(incoming) => {
        setFile(incoming);
        setOriginal(true);
      }}
    />
  );
}
