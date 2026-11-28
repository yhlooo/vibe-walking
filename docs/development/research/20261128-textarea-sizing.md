# 文本框随内容调整高度

固定宽度的文本框可以使用 `field-sizing: content`，由浏览器根据实际换行计算高度，同时用最小和最大高度限制可见行数。Chrome 123、Edge 123、Firefox 152 和 Safari 26.2 起支持该属性。较早的版本通过测量文本框的 `scrollHeight` 获得换行后的高度，并沿用同一组 CSS 上下限。见[规范及浏览器文档摘录](../reference/textarea-field-sizing.md)。
