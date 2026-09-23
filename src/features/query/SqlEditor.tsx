import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  autocompletion,
  acceptCompletion,
  startCompletion,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { sql, MySQL } from '@codemirror/lang-sql';
import { linter } from '@codemirror/lint';
import type { Table } from '@/domain/database';
import { sqlCompletions, typeDiagnostics } from './sql-assistance';

interface Props {
  value: string;
  tables: Table[];
  onChange(value: string): void;
  onRun(): void;
}
const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: '#101724', color: '#ddc9ff', fontSize: '13px' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, monospace', lineHeight: '1.8' },
    '.cm-content': { padding: '5px 0 14px', caretColor: '#e5d7ff' },
    '.cm-gutters': { backgroundColor: '#101724', color: '#677893', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px' },
    '.cm-activeLine': { backgroundColor: '#7953c510' },
    '&.cm-focused': { outline: 'none' },
    '.cm-tooltip': { backgroundColor: '#1b2537', color: '#e5d7ff', border: '1px solid #725699' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#7953c5',
      color: '#fff',
    },
    '.cm-completionDetail': { color: '#aab8d0', marginLeft: '12px' },
    '.cm-diagnostic-error': { borderLeftColor: '#fa647c' },
  },
  { dark: true },
);

export function SqlEditor({ value, tables, onChange, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const completion = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          bracketMatching(),
          sql({ dialect: MySQL }),
          syntaxHighlighting(defaultHighlightStyle),
          theme,
          EditorView.contentAttributes.of({
            'aria-label': 'SQLクエリ',
            'aria-multiline': 'true',
            spellcheck: 'false',
          }),
          completion.current.of(
            autocompletion({
              override: [sqlCompletions(tables)],
              activateOnTyping: true,
              interactionDelay: 0,
            }),
          ),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  callbacks.current.onRun();
                  return true;
                },
              },
              { key: 'Tab', run: acceptCompletion },
              { key: 'Mod-Space', run: startCompletion },
            ]),
          ),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          linter((view) => typeDiagnostics(view.state.doc.toString()), { delay: 350 }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
    // One editor instance per query tab; callbacks stay current through the ref.
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: completion.current.reconfigure(
        autocompletion({
          override: [sqlCompletions(tables)],
          activateOnTyping: true,
          interactionDelay: 0,
        }),
      ),
    });
  }, [tables]);
  return <div className="sql-code-editor" ref={host} />;
}
