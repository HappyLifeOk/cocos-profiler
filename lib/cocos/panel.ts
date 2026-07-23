// Copyright (c) cc-profiler contributors
// SPDX-License-Identifier: Apache-2.0
//
// profiler — cocos/panel.ts
// 渲染层（绑 Cocos）。宿主可注入现有顶层 UI 节点，从而复用业务 Camera；
// 未注入宿主（独立调试场景）时回退到自建 Canvas + Camera + Layers.PROFILER 层。
// 文本走 Label CHAR 池：多行 Label 共享字符 atlas batch 成单 drawcall，开销稳定可预期。

import {
    Camera, Canvas, Color, Graphics, HorizontalTextAlignment, Label, Layers, Node,
    UITransform, Widget, director, view,
} from 'cc';
import { Row } from '../core/metric';

const PANEL_W = 360;   // 容器固定宽（含内边距）：超长文字靠 Label.Overflow.SHRINK 自适应缩小字号，不溢出
const LINE_H = 32;     // 行高
const FONT = 24;       // 字号
const PAD = 12;        // 内边距
const LEADING = LINE_H - FONT;  // 单行 lineHeight 框比字形高出的 leading；只出现在最后一行下方，需补偿对齐
const CAMERA_PRIORITY = (1 << 30) + 100;   // 默认 UI Camera priority = 1<<30；+100 确保面板凌驾于业务 camera 之上
const COLOR_NORMAL = new Color(255, 255, 255, 255);
const COLOR_WARN = new Color(255, 85, 85, 255);
const BG_FILL = new Color(0, 0, 0, 160);

/** 惰性返回可承载面板的现有全屏 UI 节点；返回无效节点时走独立 Camera 回退。 */
export type ProfilerPanelHostProvider = () => Node;

/** 性能面板：优先复用宿主 UI Camera，独立场景回退自建 Camera。纯展示，不碰数据采集。 */
export class ProfilerPanel {
    private _cnvRoot: Node = null;   // 仅 fallback 模式存在；hide 时销毁，子节点跟着死
    private _root: Node = null;      // 面板容器
    private _lines: Label[] = [];    // 行级 Label 池：每行一个 Label CHAR，逐行复用避免节点抖动
    private _bg: Graphics = null;
    private _hostProvider: ProfilerPanelHostProvider = null;

    public setHostProvider(provider: ProfilerPanelHostProvider): void {
        this._hostProvider = provider;
    }

    public isShowing(): boolean {
        return !!this._root && this._root.isValid;
    }

    /** fallback 比宿主更早创建时，宿主一就绪便迁移并销毁独立 Camera。 */
    public syncHost(): void {
        if (!this._root || !this._root.isValid) return;
        if (!this._cnvRoot || !this._cnvRoot.isValid) {
            const parent = this._root.parent;
            if (parent && this._root.getSiblingIndex() !== parent.children.length - 1) {
                this._root.setSiblingIndex(parent.children.length - 1);
            }
            return;
        }
        if (!this._hostProvider) return;
        const host = this._hostProvider();
        if (!host || !host.isValid) return;

        const cnvRoot = this._cnvRoot;
        director.removePersistRootNode(cnvRoot);
        this._root.setParent(host);
        this._setLayerTree(this._root, host.layer);
        const widget = this._root.getComponent(Widget);
        if (widget) widget.updateAlignment();
        this._root.setSiblingIndex(host.children.length - 1);
        this._cnvRoot = null;
        cnvRoot.destroy();
    }

    /** 优先挂到宿主顶层 UI；宿主尚未就绪时保留独立 Canvas + Camera 兼容路径。 */
    public show(): boolean {
        if (this.isShowing()) return true;
        this._cnvRoot = null;

        const host = this._hostProvider ? this._hostProvider() : null;
        if (host && host.isValid) {
            this._buildPanel(host, host.layer);
        } else {
            const scene = director.getScene();
            if (!scene) {
                console.warn('ProfilerPanel', 'show 失败：当前无场景');
                return false;
            }

            const cnvNode = this._createCanvasRoot();
            this._buildPanel(cnvNode, Layers.Enum.PROFILER);

            // 一次性 addChild 入场景：所有组件 onLoad/onEnable 一起触发，Canvas 拿到已绑定的 cameraComponent 自动 alignWithScreen
            scene.addChild(cnvNode);
            // 独立场景 fallback 跨场景持久；宿主模式由宿主 UI 根节点管理生命周期
            director.addPersistRootNode(cnvNode);
            this._cnvRoot = cnvNode;
        }

        const widget = this._root.getComponent(Widget);
        if (widget) widget.updateAlignment();

        // 初始背景：先画一行高度，避免首次 render 之前面板视觉为空
        const h = PAD * 2 + LINE_H - LEADING;
        this._bg.clear();
        this._bg.fillColor = BG_FILL;
        this._bg.rect(0, 0, PANEL_W, h);
        this._bg.fill();
        return true;
    }

    public hide(): void {
        if (this._cnvRoot && this._cnvRoot.isValid) {
            // persist root 列表持有节点引用，destroy 前先移除避免引用泄漏
            director.removePersistRootNode(this._cnvRoot);
            this._cnvRoot.destroy();
        } else if (this._root && this._root.isValid) {
            // Hosted 模式只销毁面板自身，绝不能销毁宿主的 Fly / TopOverlay 根节点。
            this._root.destroy();
        }
        this._cnvRoot = null;
        this._root = null;
        this._lines = [];
        this._bg = null;
    }

    /** 把 Row[] 渲染上去：池化 Label CHAR，逐行设 string + color，从顶向下排列；按行数撑 root 高度并重绘背景。 */
    public render(rows: Row[]): void {
        if (!this._root || !this._root.isValid) return;
        const parent = this._root.parent;
        if (parent && this._root.getSiblingIndex() !== parent.children.length - 1) {
            this._root.setSiblingIndex(parent.children.length - 1);
        }

        // 扩容
        while (this._lines.length < rows.length) {
            this._lines.push(this._createLine());
        }
        // 缩容（多余 Label 销毁）
        while (this._lines.length > rows.length) {
            const label = this._lines.pop();
            if (label && label.node.isValid) label.node.destroy();
        }

        const N = rows.length;
        const h = PAD * 2 + N * LINE_H - LEADING;
        const rootUT = this._root.getComponent(UITransform);
        if (rootUT) rootUT.setContentSize(PANEL_W, h);

        // 填内容 + 位置 + 显式刷新 width（Label anchor (0, 1)：position 是左上角；从顶向下依次排列）
        // 显式每帧设 Label width = PANEL_W - PAD*2：SHRINK 算法以此为基准算缩放比；
        // 不设的话 Label 内部 layout 可能用初始或残留尺寸，导致 SHRINK 缩得过狠/不缩
        const labelW = PANEL_W - PAD * 2;
        rows.forEach((r, i) => {
            const label = this._lines[i];
            label.string = r.text;
            label.color = r.warn ? COLOR_WARN : COLOR_NORMAL;
            const lut = label.node.getComponent(UITransform);
            if (lut) lut.setContentSize(labelW, LINE_H);
            label.node.setPosition(PAD, h - PAD - i * LINE_H, 0);
        });

        // 重绘背景：BG_FILL 是模块级 Color 实例，避免每帧 new
        this._bg.clear();
        this._bg.fillColor = BG_FILL;
        this._bg.rect(0, 0, PANEL_W, h);
        this._bg.fill();
    }

    // 自建 Canvas + Camera：拆分到独立子节点，避免 Canvas._onResizeCamera 把 z=1000 拉到同节点导致 UI 被 near plane 裁掉
    private _createCanvasRoot(): Node {
        const visibleSize = view.getVisibleSize();
        const cnvNode = new Node('ProfilerCanvas');
        cnvNode.layer = Layers.Enum.PROFILER;
        const cnvUT = cnvNode.addComponent(UITransform);
        cnvUT.setContentSize(visibleSize.width, visibleSize.height);
        cnvNode.setPosition(visibleSize.width / 2, visibleSize.height / 2, 0);

        const camNode = new Node('ProfilerCamera');
        camNode.layer = Layers.Enum.PROFILER;
        camNode.parent = cnvNode;
        const cam = camNode.addComponent(Camera);
        cam.projection = Camera.ProjectionType.ORTHO;
        cam.visibility = Layers.Enum.PROFILER;   // 只渲染 PROFILER 层：业务 camera visibility 不含本层，互不干扰
        cam.priority = CAMERA_PRIORITY;
        cam.clearFlags = Camera.ClearFlag.DONT_CLEAR;   // 多 camera 叠加渲染，不清屏
        cam.near = 1;
        cam.far = 2000;

        const cnv = cnvNode.addComponent(Canvas);
        cnv.cameraComponent = cam;
        return cnvNode;
    }

    // 面板容器：Container + Graphics 背景 + Widget 贴左下；行 Label 在 render 时按需池化
    private _buildPanel(parent: Node, renderLayer: number): void {
        const root = new Node('ProfilerPanel');
        root.layer = renderLayer;
        root.parent = parent;
        const rootUT = root.addComponent(UITransform);
        rootUT.setContentSize(PANEL_W, PAD * 2 + LINE_H);
        rootUT.setAnchorPoint(0, 0);
        rootUT.hitTest = (): boolean => false;   // 输入透明：覆盖区域 click 穿透到下层

        const bg = root.addComponent(Graphics);
        bg.fillColor = BG_FILL;

        const widget = root.addComponent(Widget);
        widget.isAlignLeft = true;
        widget.isAlignBottom = true;
        widget.left = 10;
        widget.bottom = 10;
        widget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;

        this._root = root;
        this._bg = bg;
        this._lines = [];
    }

    private _setLayerTree(node: Node, renderLayer: number): void {
        node.layer = renderLayer;
        const children = node.children;
        for (let i = 0; i < children.length; i++) this._setLayerTree(children[i], renderLayer);
    }

    // 创建一行 Label：CHAR 缓存让多个 Label 共享同一字符 atlas → batch 成 1 个 drawcall
    private _createLine(): Label {
        const node = new Node('line');
        node.layer = this._root.layer;
        node.parent = this._root;
        const ut = node.addComponent(UITransform);
        ut.setContentSize(PANEL_W - PAD * 2, LINE_H);
        ut.setAnchorPoint(0, 1);
        ut.hitTest = (): boolean => false;
        const label = node.addComponent(Label);
        label.fontSize = FONT;
        label.lineHeight = LINE_H;
        label.cacheMode = Label.CacheMode.CHAR;
        label.horizontalAlign = HorizontalTextAlignment.LEFT;
        // 关掉 wrap：默认 enableWrapText=true 会让超宽行优先换行而不走 SHRINK；强制单行后 SHRINK 才会按比例缩字
        label.enableWrapText = false;
        // SHRINK：文字超过 contentSize 宽度时按比例缩小字号让单行容下，常规短行不触发缩小、字号恒定
        label.overflow = Label.Overflow.SHRINK;
        label.string = '';
        return label;
    }
}
