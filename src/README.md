# 运行模块

本目录包含 runtime-manifest.json 列出的 12 个自写运行模块：启动与停止脚本、运行入口、事件索引、preload 中继、原生事件桥接、嵌套界面、级联归档，以及关系发现和聊天辅助脚本。

安装器按清单复制源码，缺少文件时停止。安装后生成的关系、偏好和运行记录通过 `CNCC_DATA_DIR` 保存在独立数据目录，个人数据、生产备份和官方资源不随源码分发。模块间的运行约定见 [runtime-integration.md](../docs/runtime-integration.md)。
