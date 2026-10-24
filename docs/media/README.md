# docs/media

README 用的演示素材。这两个文件已经由宣传片流水线导出并提交，替换时按下面的要求来。

## 需要的文件

| 文件 | 要求 | 用途 |
| --- | --- | --- |
| `token-diet-demo.gif` | ≤ 8 MB，800px 宽、12fps、约 15 秒，展示 80% 提醒 → 到达预算停下 | README「演示」一节 |
| `overview.png` | 1600px 以上宽（2× 截图），浅色主题，含页签、KPI、趋势与按模型表格 | README「演示」一节 |

重新生成（宣传片工程是作者私有内容，不在本仓库；先按私有手册备好夹具与素材，出片后再截）：

```bash
ffmpeg -ss 38 -t 15 -i promo/out/token-diet-promo-480p-vo-news-anchor.mp4 \
  -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  -loop 0 docs/media/token-diet-demo.gif
```

## 注意

- 截图与 GIF 里不能出现真实用户名、绝对路径、密钥、公司信息或真实会话内容；用演示 profile 或脱敏会话。
- 大文件不提交到 git 历史：GIF 与截图可以随仓库提交（受上面的体积限制），宣传片视频请挂到
  GitHub Release，见 [RELEASING.md](../../RELEASING.md)。
- 更新素材后检查 README 中的相对路径仍然是 `docs/media/token-diet-demo.gif` 与 `docs/media/overview.png`。