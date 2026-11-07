"use strict";
exports.activate = context => {
 const { vscode } = context;
 return { async editDocument(uri, text) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const changed = await editor.edit(builder => builder.replace(new vscode.Range(0, 0, doc.lineCount, 0), text));
  if (!changed) throw new Error("Native synchronous edit failed");
  return doc.getText();
 } };
};
