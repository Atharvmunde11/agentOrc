declare module "pdf-parse" {
  const pdfParse: (data: Buffer) => Promise<{ text: string; numpages?: number }>;
  export default pdfParse;
}
