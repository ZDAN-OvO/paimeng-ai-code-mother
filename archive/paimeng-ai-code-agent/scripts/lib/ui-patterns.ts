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

/**
 * 一条 antd 废弃属性。表是唯一来源：新踩一次就在表里加一行，而不是再加一条正则。
 * `since` 只是给人看的版本线索，判定不看它。
 */
export type DeprecatedProp = {
  readonly component: string;
  readonly prop: string;
  readonly replacement: string;
  readonly since: string;
};

/**
 * antd v6 的废弃属性只在开发构建里告警，生产构建和现有 E2E 都看不见。
 * 每条都对应一次真实事故，见 `scripts/verify/check-ui-patterns.ts` 顶部说明。
 */
export const antdDeprecatedProps: readonly DeprecatedProp[] = [
  {
    component: 'Input',
    prop: 'addonAfter',
    replacement: '用 Space.Compact 组合输入框与按钮',
    since: 'antd v6',
  },
  {
    component: 'Input',
    prop: 'addonBefore',
    replacement: '用 Space.Compact 组合输入框与按钮',
    since: 'antd v6',
  },
  { component: 'Space', prop: 'direction', replacement: 'orientation', since: 'antd v6' },
  { component: 'Drawer', prop: 'width', replacement: 'size', since: 'antd v6' },
];

/** 按表逐条比对 JSX 属性；命中一行报一行。 */
export function deprecatedPropViolations(
  file: string,
  text: string,
  rules: readonly DeprecatedProp[] = antdDeprecatedProps,
): string[] {
  if (rules.length === 0) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      for (const rule of rules) {
        if (tag !== rule.component) continue;
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          if (attribute.name.getText(source) !== rule.prop) continue;
          const line = source.getLineAndCharacterOfPosition(attribute.getStart(source)).line + 1;
          violations.push(
            `${file}:${line}: <${rule.component}> 的 ${rule.prop} 在 ${rule.since} 已废弃（只在 dev 告警）：改用 ${rule.replacement}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

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
