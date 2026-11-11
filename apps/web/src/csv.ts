/** Minimal subset of Document used for the download, so tests can fake it. */
export interface DocLike {
  createElement(tag: "a"): {
    href: string;
    download: string;
    rel: string;
    click(): void;
    remove(): void;
  };
  body: { appendChild(node: unknown): unknown };
}

export const CSV_FILENAME = "openlid-export-demo-not-a-tax-document.csv";

/** Start a browser download of `href` (the API's /api/export.csv or a blob: URL). */
export function triggerCsvDownload(doc: DocLike, href: string): void {
  const a = doc.createElement("a");
  a.href = href;
  a.download = CSV_FILENAME;
  a.rel = "noopener";
  doc.body.appendChild(a);
  a.click();
  a.remove();
}
