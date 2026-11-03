import ts from 'typescript';

const wrapperTags = new Set([
  'Space',
  'Space.Compact',
  'div',
  'span',
  'section',
  'Row',
  'Col',
  'Card',
]);

/** Only named Form.Item children receive antd's injected value/onChange. */
export function formItemWiringViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(source) === 'Form.Item' &&
      node.openingElement.attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'name',
      )
    ) {
      for (const child of node.children) {
        const line = source.getLineAndCharacterOfPosition(child.getStart(source)).line + 1;
        if (
          ts.isJsxExpression(child) &&
          child.expression &&
          ts.isStringLiteral(child.expression) &&
          child.expression.text.trim() === ''
        ) {
          violations.push(
            `${file}:${line}: 不要在有 name 的 Form.Item 中用 {' '} 做间距：它会增加子节点，导致控件不再绑定表单。用 CSS gap 或把间距放到 Form.Item 外面`,
          );
        }
        const tag = ts.isJsxElement(child)
          ? child.openingElement.tagName.getText(source)
          : ts.isJsxSelfClosingElement(child)
            ? child.tagName.getText(source)
            : null;
        if (tag && wrapperTags.has(tag)) {
          violations.push(
            `${file}:${line}: 有 name 的 Form.Item 直接子节点是 <${tag}>：antd 注入的 value/onChange 会被丢掉，字段收不到值。把控件放在直接子节点，按钮等放到 Form.Item 外面`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}
