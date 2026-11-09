// Only infer an attachment for an explicit request. Quoted dialogue and
// negative instructions about sharing/inspecting an image are not permission.
export function reviewIntent(text) {
  const request = String(text || '').replace(/“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"]*(?:"|$)|\x60[^\x60]*(?:\x60|$)|(?:^|\s)'[^']*'(?:\s|$)/gu, ' ');
  const refuseShare = /(?:不要|不必|不用|无需|不许|禁止|拒绝|别)[^，,。；;\n]{0,20}(?:上传|发给|传给|送给|交给|发送给|分享)|(?:don't|do not|never|without)\s+(?:sending|sharing|send|upload|share)\b/i;
  if (refuseShare.test(request)) return '';
  const inspect = /(?:看看|看一下|看下|看一眼|检查|审视|评估|评价|点评|评论|分析|审阅|描述|复盘|review|inspect|critique|analy[sz]e|look at|check|describe)/gi;
  const after = /(?:生成|绘制|画|出图|渲染)(?:好|完(?:成)?|出来)?(?:以后|之后|后|完)|after (?:you )?(?:generat|draw|render)|(?:draw|generate|render).{0,65}(?:then|and)\s*$/i;
  const previous = /(?:上[一次张幅]+|刚才|刚刚|刚出的|刚画的|刚生成的)[^，,。；;\n]{0,10}(?:图|画|作品|效果)|(?:你(?:刚才|刚刚|刚)?(?:自己)?(?:画|生成|渲染|生)(?:出来|好|完)?的)[^，,。；;\n]{0,10}(?:图|画|作品|效果)|(?:last|latest|previous|just.generated).{0,16}(?:image|picture|illustration)|(?:image|picture|illustration) you (?:just )?(?:made|drew|generated)/i;
  const negate = /(?:不要|不用|无需|无须|不需(?:要)?|不必|不许|禁止|拒绝|别|不再|不要再|不)(?:再|也|去|帮我|让(?:模型|你)|替我|主动|自己|对(?:上一张|这张|生成的)?(?:图像|图片|成图|图))*(?:进行)?\s*$|(?:do not|don't|never|no need to|avoid|without)(?:\s+(?:also|then|first|you|ever|further|to))?\s*$/i;
  let intent = '';
  for (const sentence of request.split(/[。！？!?；;\n]/)) {
    for (const match of sentence.matchAll(inspect)) {
      const before = sentence.slice(0, match.index);
      const afterVerb = sentence.slice(match.index + match[0].length).split(/[,，]/)[0];
      const fromContext = before.split(/[,，]/).slice(-2).join('，');
      const oldTarget = previous.test(afterVerb) || previous.test(before.split(/[,，]/).at(-1));
      const newTarget = after.test(fromContext) || /(?:生成|画|渲染)(?:好|完|出来)?后(?:的)?(?:成图|图片|效果|结果)/.test(afterVerb);
      if (negate.test(before)) { if (oldTarget || newTarget || intent) intent = ''; continue; }
      // "of/at the previous image" points to an existing work, even when
      // the same message also asks for a new illustration.
      if (newTarget && !/(?:上一张|上次|之前|previous|last image)/i.test(afterVerb)) intent = 'after';
      else if (oldTarget) intent = 'last';
    }
  }
  return intent;
}
