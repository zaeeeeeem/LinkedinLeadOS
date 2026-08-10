import * as cheerio from "cheerio";

export type InboxDomProbeMap = {
  nodes: number;
  textChars: number;
  anchors: {
    dataTestId: number;
    componentKey: number;
    role: number;
    messagingThreadHref: number;
  };
};

/**
 * Content-free DOM inventory for the inbox probe. The labeled Voyager body is
 * the field source (D291), so the DOM measurement only answers whether stable
 * anchor families rendered. It records counts, never attribute values or text.
 */
export function buildInboxDomProbeMap(html: string): InboxDomProbeMap {
  const $ = cheerio.load(html);
  return {
    nodes: $("*").length,
    textChars: $.root().text().length,
    anchors: {
      dataTestId: $("[data-testid]").length,
      componentKey: $("[componentkey]").length,
      role: $("[role]").length,
      messagingThreadHref: $('a[href*="/messaging/thread/"]').length,
    },
  };
}

export function renderInboxDomProbeMap(input: {
  file: string;
  bytes: number;
  sourceRun: string;
  map: InboxDomProbeMap;
}): string {
  const { map } = input;
  return (
    `## \`${input.file}\` — rendered DOM snapshot (inbox probe)\n\n` +
    `- source run: \`${input.sourceRun}\`; bytes: ${input.bytes}; nodes: ${map.nodes}; text chars: ${map.textChars}\n` +
    `- stable-anchor counts: data-testid ${map.anchors.dataTestId}; componentkey ${map.anchors.componentKey}; ` +
      `role ${map.anchors.role}; messaging-thread href ${map.anchors.messagingThreadHref}\n` +
    `- no message field is mapped from DOM: the labeled Voyager body wins (D291)\n\n`
  );
}
