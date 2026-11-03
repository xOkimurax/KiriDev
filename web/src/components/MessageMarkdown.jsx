import React from 'react';

const inlineToken = /(\*\*[^*]+\*\*|__[^_]+__|`[^`\n]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+)/g;
const listItem = /^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/;

function inline(text) {
  const nodes = [];
  let cursor = 0;

  for (const match of text.matchAll(inlineToken)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = match.index;

    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{inline(token.slice(2, -2))}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const markdownLink = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      const label = markdownLink?.[1];
      const url = markdownLink?.[2] || token.replace(/[.,;!?]+$/, '');
      const punctuation = label ? '' : token.slice(url.length);
      nodes.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer">
          {label || url}
        </a>,
      );
      if (punctuation) nodes.push(punctuation);
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export default function MessageMarkdown({ text }) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    if (/^\s*```/.test(lines[index])) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={blocks.length}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const firstItem = lines[index].match(listItem);
    if (firstItem) {
      const ordered = /^\d/.test(firstItem[1]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(listItem);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(<li key={items.length}>{inline(item[2])}</li>);
        index += 1;
      }
      blocks.push(ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !listItem.test(lines[index]) &&
      !/^\s*```/.test(lines[index])
    ) {
      paragraph.push(lines[index].replace(/^\s{0,3}#{1,6}\s+/, '').trim());
      index += 1;
    }
    blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '))}</p>);
  }

  return <div className="message-content">{blocks}</div>;
}
