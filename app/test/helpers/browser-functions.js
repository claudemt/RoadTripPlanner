const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const appRoot = path.resolve(__dirname, '../..');

const createBrowserContext = (globals = {}) => vm.createContext({
  window: {}, structuredClone, setTimeout, clearTimeout, console, ...globals,
});

const loadBrowserFile = (context, relativePath) => {
  vm.runInContext(fs.readFileSync(path.join(appRoot, relativePath), 'utf8'), context);
};

// Run real event handlers with controlled async dependencies and no DOM/network.
const loadFunctions = (context, names, relativePath = 'web/src/main.js') => {
  const source = fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
  const ast = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const name of names) {
    const statement = ast.statements.find((node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(ast) === name))
      || (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(ast) === `window.${name}`));
    if (!statement) throw new Error(`Missing handler ${name}`);
    vm.runInContext(statement.getText(ast), context);
  }
};

module.exports = {createBrowserContext, loadBrowserFile, loadFunctions};
