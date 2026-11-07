import { describe, expect, it } from 'vitest';
import {
  antdDeprecatedProps,
  deprecatedPropViolations,
  formItemWiringViolations,
} from '../../../scripts/lib/ui-patterns';

const check = (jsx: string) => formItemWiringViolations('fixture.tsx', jsx);
const deprecated = (jsx: string) => deprecatedPropViolations('fixture.tsx', jsx);

describe('antd Form.Item wiring guard', () => {
  it('allows Prettier spacing between ordinary text and a link', () => {
    expect(check("<div>已有账号？{' '}<Link href='/login'>登录</Link></div>")).toEqual([]);
  });

  it('rejects explicit whitespace beside a named form control', () => {
    expect(check("<Form.Item name='enabled'><Switch />{' '}</Form.Item>")).toEqual([
      expect.stringContaining('不要在有 name 的 Form.Item'),
    ]);
  });

  it('rejects double quoted whitespace across lines', () => {
    expect(check('<Form.Item name="enabled">\n<Switch />\n{" "}\n</Form.Item>')).toEqual([
      expect.stringContaining('fixture.tsx:3:'),
    ]);
  });

  it('allows whitespace in a label attribute and ordinary JSX indentation', () => {
    expect(
      check(
        '<Form.Item name="enabled" label={<span>是否{" "}启用</span>}>\n<Switch />\n</Form.Item>',
      ),
    ).toEqual([]);
  });

  it('allows layout in unnamed form items', () => {
    expect(check("<Form.Item><Space><Button />{' '}<Button /></Space></Form.Item>")).toEqual([]);
  });

  it.each(['Space', 'Space.Compact', 'div', 'span', 'section', 'Row', 'Col', 'Card'])(
    'rejects a %s wrapper around a named control',
    (tag) => {
      expect(check(`<Form.Item name='enabled'><${tag}><Switch /></${tag}></Form.Item>`)).toEqual([
        expect.stringContaining(`直接子节点是 <${tag}>`),
      ]);
    },
  );

  it('rejects a self closing layout wrapper', () => {
    expect(check("<Form.Item name='enabled'><Space /></Form.Item>")).toHaveLength(1);
  });

  it('allows a directly bound control with a validator containing >', () => {
    expect(
      check(
        "<Form.Item name='title' rules={[{ validator: (_, value) => value.length > 0 }]}><Input /></Form.Item>",
      ),
    ).toEqual([]);
  });

  it('checks named items nested inside ordinary layout', () => {
    expect(
      check("<div><Form.Item name='enabled'><Space><Switch /></Space></Form.Item></div>"),
    ).toHaveLength(1);
  });
});

describe('antd deprecated prop guard', () => {
  // 真实事故：fd2c19d 的 model-manager 配置模型抽屉写了 width={620}，只在 dev 告警。
  it('rejects Drawer width and points at the attribute line', () => {
    const violations = deprecated('<Drawer open width={620}>\n<Form />\n</Drawer>');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('fixture.tsx:1:');
    expect(violations[0]).toContain('<Drawer> 的 width 在 antd v6 已废弃');
    expect(violations[0]).toContain('改用 size');
  });

  it('allows the size replacement', () => {
    expect(deprecated('<Drawer open size={620} />')).toEqual([]);
  });

  it('catches a deprecated prop written on its own line', () => {
    expect(deprecated('<Space\n  direction="vertical"\n  size="small"\n/>')).toHaveLength(1);
  });

  it.each([
    ['Space', 'direction'],
    ['Input', 'addonAfter'],
    ['Input', 'addonBefore'],
  ])('rejects %s %s', (component, prop) => {
    expect(deprecated(`<${component} ${prop}="x" />`)).toEqual([
      expect.stringContaining(`<${component}> 的 ${prop}`),
    ]);
  });

  it('does not confuse a similarly named component or prop', () => {
    expect(deprecated('<Box width={1} />')).toEqual([]);
    expect(deprecated('<Drawer open size={620} title="标题" />')).toEqual([]);
  });

  it('reports one violation per deprecated attribute', () => {
    expect(deprecated('<Input addonBefore="a" addonAfter="b" />')).toHaveLength(2);
  });

  it('checks every rule in the table', () => {
    for (const rule of antdDeprecatedProps) {
      expect(deprecated(`<${rule.component} ${rule.prop}="x" />`)).toHaveLength(1);
    }
  });
});
