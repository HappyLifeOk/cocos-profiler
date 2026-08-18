// Copyright (c) cc-profiler contributors
// SPDX-License-Identifier: Apache-2.0
//
// profiler — cocos/cocos-profiler.ts
// Cocos 适配层装配：director hook 采集引擎指标 + 驱动 core 采样 + 面板刷新 + 平台存储注入。
// 业务层通过 showProfiler / hideProfiler 进出，不直接碰 core 渲染细节。

import { director, DirectorEvent, gfx, profiler as engineProfiler } from 'cc';
import { profiler } from '../core/registry';
import { ProfilerPanel, type ProfilerPanelHostProvider } from './panel';
import { LocalStorageAdapter } from './local-storage';

const { deviceManager } = gfx;
const REFRESH_MS = 1000;   // 面板文本刷新 / fps 统计窗口
const MB = 1024 * 1024;

/** 引擎指标采集 + 驱动 + 面板。耗时类指标靠 director hook 间时间差，闭包喂给 core。 */
class ProfilerCocos {
    private _panel = new ProfilerPanel();
    private _device: gfx.Device = null;
    private _hooked = false;
    private _storageReady = false;
    private _metricsReady = false;
    private _last = 0;

    // 各阶段耗时（每帧 hook 更新）；引擎读数（每帧读 device 字段）
    private _t = { frame: 0, logic: 0, physics: 0, render: 0, present: 0 };
    private _mark = { frame: 0, logic: 0, physics: 0, render: 0, present: 0 };
    private _stat = { draws: 0, instances: 0, tris: 0, texMB: 0, bufMB: 0 };
    private _frames = 0;
    private _fpsStart = 0;
    private _fps = 0;

    public show(): void {
        if (this._panel.isShowing()) return;
        this.ensureSetup();
        this._device = deviceManager.gfxDevice;
        this._fpsStart = performance.now();
        this._last = this._fpsStart;
        if (!this._panel.show()) {
            this._device = null;
            return;
        }
        this._hook();
        // 关引擎自带 fps 面板：toolbar Show FPS 按钮 click 会同时触发 cc.profiler.showStats 与本 listener，
        // 不关掉会出现"原版 + 自定义面板"并排显示。引擎 11 项指标本面板已覆盖，无并存价值。
        if (engineProfiler) engineProfiler.hideStats();
        profiler.markShowing(true);
    }

    public hide(): void {
        if (!this._panel.isShowing() && !this._hooked) return;
        this._unhook();
        this._panel.hide();
        this._device = null;
        profiler.markShowing(false);
    }

    public isShowing(): boolean {
        return this._panel.isShowing();
    }

    public setPanelHostProvider(provider: ProfilerPanelHostProvider): void {
        this._panel.setHostProvider(provider);
    }


    // 存储 / 指标注册各只做一次（show 可多次开关，注册幂等）

    /** 只装配（存储注入 + 引擎指标注册），不显示面板。集成层构建勾选列表前可先调一次，幂等。 */
    public ensureSetup(): void {
        this._ensureStorage();
        this._ensureMetrics();
    }

    private _ensureStorage(): void {
        if (this._storageReady) return;
        profiler.setStorage(new LocalStorageAdapter());
        this._storageReady = true;
    }

    private _ensureMetrics(): void {
        if (this._metricsReady) return;
        this._registerCocosMetrics();
        this._metricsReady = true;
    }

    /** 注册 11 项 Cocos 引擎标准指标。耗时类 get() 闭包读本类每帧测得的值。 */
    private _registerCocosMetrics(): void {
        const t = this._t;
        const stat = this._stat;
        const int = (v: number): string => Math.round(v).toString();
        const mb = (v: number): string => v.toFixed(1);
        profiler.register({ id: 'fps', label: '帧率', get: () => this._fps, warn: (v) => v < 30, format: int, order: 1 });
        profiler.register({ id: 'frame', label: '帧耗时(ms)', get: () => t.frame, average: REFRESH_MS, warn: (v) => v > 33, order: 2 });
        profiler.register({ id: 'logic', label: '逻辑耗时(ms)', get: () => t.logic, average: REFRESH_MS, order: 3 });
        profiler.register({ id: 'physics', label: '物理耗时(ms)', get: () => t.physics, average: REFRESH_MS, order: 4, defaultEnabled: false });
        profiler.register({ id: 'render', label: '渲染耗时(ms)', get: () => t.render, average: REFRESH_MS, order: 5 });
        profiler.register({ id: 'present', label: '提交耗时(ms)', get: () => t.present, average: REFRESH_MS, order: 6 });
        profiler.register({ id: 'draws', label: '绘制调用', get: () => stat.draws, average: REFRESH_MS, format: int, order: 7 });
        profiler.register({ id: 'instances', label: '实例数', get: () => stat.instances, average: REFRESH_MS, format: int, order: 8, defaultEnabled: false });
        profiler.register({ id: 'tricount', label: '三角面数', get: () => stat.tris, average: REFRESH_MS, format: int, order: 9 });
        profiler.register({ id: 'textureMemory', label: '纹理显存(M)', get: () => stat.texMB, format: mb, order: 10 });
        profiler.register({ id: 'bufferMemory', label: '缓冲显存(M)', get: () => stat.bufMB, format: mb, order: 11 });
    }

    private _hook(): void {
        if (this._hooked) return;
        director.on(DirectorEvent.BEFORE_UPDATE, this._beforeUpdate, this);
        director.on(DirectorEvent.AFTER_UPDATE, this._afterUpdate, this);
        director.on(DirectorEvent.BEFORE_PHYSICS, this._beforePhysics, this);
        director.on(DirectorEvent.AFTER_PHYSICS, this._afterPhysics, this);
        director.on(DirectorEvent.BEFORE_DRAW, this._beforeDraw, this);
        director.on(DirectorEvent.AFTER_RENDER, this._afterRender, this);
        director.on(DirectorEvent.AFTER_DRAW, this._afterPresent, this);
        this._hooked = true;
    }

    private _unhook(): void {
        if (!this._hooked) return;
        director.off(DirectorEvent.BEFORE_UPDATE, this._beforeUpdate, this);
        director.off(DirectorEvent.AFTER_UPDATE, this._afterUpdate, this);
        director.off(DirectorEvent.BEFORE_PHYSICS, this._beforePhysics, this);
        director.off(DirectorEvent.AFTER_PHYSICS, this._afterPhysics, this);
        director.off(DirectorEvent.BEFORE_DRAW, this._beforeDraw, this);
        director.off(DirectorEvent.AFTER_RENDER, this._afterRender, this);
        director.off(DirectorEvent.AFTER_DRAW, this._afterPresent, this);
        this._hooked = false;
    }

    private _beforeUpdate(): void {
        const now = performance.now();
        this._mark.frame = now;
        this._mark.logic = now;
    }

    private _afterUpdate(): void {
        const now = performance.now();
        if (director.isPaused()) {
            this._mark.frame = now;   // 暂停：重置 frame 起点，不计入帧耗时
            return;
        }
        this._t.logic = now - this._mark.logic;
    }

    private _beforePhysics(): void {
        this._mark.physics = performance.now();
    }

    private _afterPhysics(): void {
        this._t.physics = performance.now() - this._mark.physics;
    }

    private _beforeDraw(): void {
        this._mark.render = performance.now();
    }

    private _afterRender(): void {
        const now = performance.now();
        this._t.render = now - this._mark.render;
        this._mark.present = now;
    }

    private _afterPresent(): void {
        const now = performance.now();
        this._t.frame = now - this._mark.frame;
        this._t.present = now - this._mark.present;
        if (!this._panel.isShowing()) {
            this.hide();
            return;
        }
        this._panel.syncHost();

        this._frames += 1;
        const elapsed = now - this._fpsStart;
        if (elapsed >= REFRESH_MS) {
            this._fps = this._frames * 1000 / elapsed;
            this._frames = 0;
            this._fpsStart = now;
        }

        this._readDevice();
        profiler.sample(now);   // 每帧累积（averager 平均窗口靠这个）

        if (now - this._last < REFRESH_MS) return;
        this._last = now;
        this._panel.render(profiler.snapshot());   // 降频刷新文本，避免每帧重排 RichText
    }

    private _readDevice(): void {
        const d = this._device;
        if (!d) return;
        // 注：device.numDrawCalls 是全局累计，包含 panel 自身渲染（≈1 文本 batch + 1 背景 = 2 drawcall）。
        // 为了"统计精确"做扣除属于伪精确——CHAR atlas 跟业务字符共享时不增、独立时增 1，不可知；不扣保持一致性
        this._stat.draws = d.numDrawCalls;
        this._stat.instances = d.numInstances;
        this._stat.tris = d.numTris;
        this._stat.texMB = d.memoryStatus.textureSize / MB;
        this._stat.bufMB = d.memoryStatus.bufferSize / MB;
    }
}

/** 全局单例：业务接入层 import 同一个。 */
export const profilerCocos = new ProfilerCocos();

/**
 * 全局静态开关。关闭时：showProfiler 跳过、toolbar 联动按钮点击与启动自启均跳过；
 * 若面板已显示则立即 hide。hideProfiler 仍可直接调用。
 */
let _enabled = true;
let _explicitInitializationRequested = false;
let _initialized = false;
let _initializing: Promise<void> = null;
let _showAfterInitialization = false;

export function setProfilerEnabled(on: boolean): void {
    if (_enabled === on) {
        if (!on) {
            _showAfterInitialization = false;
            profilerCocos.hide();
        }
        return;
    }
    _enabled = on;
    if (!on) {
        _showAfterInitialization = false;
        profilerCocos.hide();
    }
}

export function isProfilerEnabled(): boolean {
    return _enabled;
}

/**
 * 注册宿主节点解析器。未注册或解析结果为 null 时使用独立 Canvas/Camera；
 * 解析器之后返回有效节点时，已显示的 fallback 面板也会自动迁移过去。
 */
export function registerProfilerPanelHostProvider(provider: ProfilerPanelHostProvider): void {
    profilerCocos.setPanelHostProvider(provider);
}

/** 显示性能面板。被 setProfilerEnabled(false) 关闭后此调用 noop。 */
export function showProfiler(): void {
    if (!_enabled) return;
    if (!_initialized) {
        _showAfterInitialization = true;
        if (!_initializing) _startInitialization(true);
        return;
    }
    profilerCocos.show();
}

/** 隐藏性能面板。 */
export function hideProfiler(): void {
    _showAfterInitialization = false;
    profilerCocos.hide();
}

/** 只装配（存储 + 引擎指标），不显示面板。供集成层构建勾选列表时调，幂等。 */
export function ensureEngineMetrics(): void {
    profilerCocos.ensureSetup();
}

/** 等待下一次 update，确保预览 view 与首屏尺寸已经稳定。 */
function waitForNextUpdate(): Promise<void> {
    return new Promise(resolve => director.once(DirectorEvent.AFTER_UPDATE, resolve));
}

async function _initializeProfiler(waitForViewReady: boolean): Promise<void> {
    profilerCocos.ensureSetup();
    if (waitForViewReady) await waitForNextUpdate();

    _initialized = true;
    const showAfterInitialization = _showAfterInitialization;
    _showAfterInitialization = false;
    bindPreviewToolbarToggle();
    if (showAfterInitialization && _enabled && !profilerCocos.isShowing()) profilerCocos.show();
}

function _startInitialization(waitForViewReady: boolean): Promise<void> {
    if (_initialized) return Promise.resolve();
    if (_initializing) return _initializing;
    const task = _initializeProfiler(waitForViewReady);
    _initializing = task;
    task.then(
        () => { if (_initializing === task) _initializing = null; },
        () => { if (_initializing === task) _initializing = null; },
    );
    return task;
}

/**
 * 显式初始化 Cocos Profiler。
 *
 * 首帧自动装配前调用会接管初始化。宿主通过 registerProfilerPanelHostProvider
 * 独立注册；未注册时使用默认的独立 Canvas/Camera。
 */
export function initializeProfiler(): Promise<void> {
    _explicitInitializationRequested = true;
    return _startInitialization(true);
}


let _toolbarBound = false;

/**
 * 联动 Cocos Creator 预览页 toolbar 的 "Show FPS" 按钮（#btn-show-fps，源自
 * builtin/preview/static/views/toolbar.ejs）：按下显示本面板，再按隐藏。
 * 仅在浏览器预览环境生效；非浏览器（jsb/native）或按钮不存在时静默跳过。幂等。
 * 未显式调用 initializeProfiler 时，module 会在首帧自动调一次。
 */
export function bindPreviewToolbarToggle(): void {
    if (_toolbarBound) return;
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('btn-show-fps');
    if (!btn) return;
    _toolbarBound = true;

    btn.addEventListener('click', () => {
        if (!_enabled) return;
        if (profilerCocos.isShowing()) hideProfiler();
        else showProfiler();
    });
    // 按钮已是 checked：立即触发一次 show 把面板挂上（顶层 director.once(AFTER_UPDATE) 已保证 view 就绪）
    if (_enabled && btn.classList.contains('checked')) showProfiler();
}

/** 未使用显式初始化时保留零配置自动装配；显式入口会在首帧前接管。 */
function autoInitializeProfiler(): void {
    if (_explicitInitializationRequested) return;
    _startInitialization(false);
}

// 延迟到首帧 AFTER_UPDATE：view/screen 尺寸已稳定；若业务已显式 initialize，则自动装配让位。
director.once(DirectorEvent.AFTER_UPDATE, autoInitializeProfiler);
