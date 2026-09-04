// 声线库：克隆（参考音频+精确文字稿）/ 设计（纯文字描述）双模式的 voice profile 存取。
// 纯数据模块，不依赖 SillyTavern。

export const MUTE_VOICE = { name: '🔇 静音（不朗读）', voice_id: 'breeze2:mute', lang: '-', preview_url: null };

export function newVoiceId() {
    return `breeze2:vp:${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 出厂声线：一个中性叙述者（设计模式）+ 一个示例（设计模式） */
export function defaultVoiceProfiles() {
    return [
        {
            id: newVoiceId(),
            name: '叙述者（默认）',
            mode: 'design',
            refAudio: null,
            refText: '',
            designInstruction: '一位沉稳的中性叙述者声线，咬字清晰，语速平缓，像深夜广播剧的旁白。',
            baseDirection: '',
            cfg: 4.0,
            seedMode: 'random',
            seed: 42,
            lang: 'auto',
        },
        {
            id: newVoiceId(),
            name: '示例声线（改成你的描述）',
            mode: 'design',
            refAudio: null,
            refText: '',
            designInstruction: '一位温柔的年轻女性，声音清晰柔软，语气亲切自然。',
            baseDirection: '',
            cfg: 4.0,
            seedMode: 'random',
            seed: 42,
            lang: 'auto',
        },
    ];
}

export class VoiceStore {
    /** @param {object[]} profiles */
    constructor(profiles) {
        this.profiles = Array.isArray(profiles) && profiles.length ? profiles : defaultVoiceProfiles();
    }

    all() {
        return this.profiles;
    }

    /** 按 voice_id 或名称查找 */
    get(idOrName) {
        return this.profiles.find((v) => v.id === idOrName)
            ?? this.profiles.find((v) => v.name === idOrName)
            ?? null;
    }

    /** 供 ST voice map 使用的声音列表 */
    toVoiceObjects() {
        return [
            ...this.profiles.map((v) => ({
                name: v.name,
                voice_id: v.id,
                lang: v.lang === 'auto' ? 'auto' : v.lang,
                preview_url: null,
            })),
            { ...MUTE_VOICE },
        ];
    }

    /** 新建或按 id 更新；返回存入的 profile */
    save(profile) {
        if (!profile.id) {
            profile.id = newVoiceId();
        }
        if (!profile.name || !String(profile.name).trim()) {
            profile.name = `声线 ${this.profiles.length + 1}`;
        }
        const idx = this.profiles.findIndex((v) => v.id === profile.id);
        if (idx >= 0) {
            this.profiles[idx] = profile;
        } else {
            // 名称去重
            if (this.profiles.some((v) => v.name === profile.name)) {
                profile.name = `${profile.name} (2)`;
            }
            this.profiles.push(profile);
        }
        return profile;
    }

    remove(id) {
        const idx = this.profiles.findIndex((v) => v.id === id);
        if (idx >= 0) {
            this.profiles.splice(idx, 1);
            return true;
        }
        return false;
    }

    exportJson() {
        return JSON.stringify({ schema: 'breeze2-voices/v1', voices: this.profiles }, null, 2);
    }

    /** @returns {{imported:number}} 导入条数（追加模式） */
    importJson(text) {
        const parsed = JSON.parse(text);
        const voices = Array.isArray(parsed) ? parsed : parsed?.voices;
        if (!Array.isArray(voices)) {
            throw new Error('文件格式不对：应为 {schema, voices:[...]}');
        }
        let count = 0;
        for (const raw of voices) {
            const profile = {
                id: newVoiceId(),
                name: String(raw.name ?? '导入声线').slice(0, 60),
                mode: raw.mode === 'clone' ? 'clone' : 'design',
                refAudio: raw.refAudio ?? null,
                refText: String(raw.refText ?? ''),
                designInstruction: String(raw.designInstruction ?? ''),
                baseDirection: String(raw.baseDirection ?? ''),
                cfg: Number(raw.cfg ?? 2) || 2,
                seedMode: raw.seedMode === 'fixed' ? 'fixed' : 'random',
                seed: Number(raw.seed ?? 42) || 42,
                lang: ['auto', 'zh', 'en'].includes(raw.lang) ? raw.lang : 'auto',
            };
            if (profile.mode === 'clone' && !profile.refAudio?.data) {
                continue; // 没有音频数据的克隆声线无法还原
            }
            this.save(profile);
            count++;
        }
        return { imported: count };
    }
}
