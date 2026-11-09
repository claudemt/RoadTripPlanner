# 内置背景音乐

导出视频时可选的内置曲库。服务端会扫描本目录下的 `.mp3` 文件，文件名即曲目名（`easy-monday.mp3` 显示为「Easy Monday」）。

## 添加曲目

把 `.mp3` 直接放进这个目录，刷新导出窗口即可看到，不需要改代码，也不需要重启服务。

## 为什么被 gitignore

这些音频体积较大（十余首约 50MB），且多为第三方曲库素材，因此不随仓库分发。各人本地按需放置即可：

```bash
cp ~/Music/*.mp3 app/server/assets/music/
```

新部署的机器若没有放任何文件，曲库只显示用户自己上传的音乐，功能不受影响。

## 用户上传的音乐

用户通过「上传 MP3」添加的曲目不属于内置曲库，存放在数据目录下，按邮箱隔离：

```
{ROADTRIP_DATA_ROOT}/music/users/<邮箱>/<随机 ID>.mp3
{ROADTRIP_DATA_ROOT}/music/users/<邮箱>/tracks.json      # 曲目清单
{ROADTRIP_DATA_ROOT}/music/users/<邮箱>/selections.json  # 每条路线上次选中的音乐
```

默认 `ROADTRIP_DATA_ROOT` 为项目根目录的 `data/`，线上部署通常是 `/var/lib/roadtrip`。
