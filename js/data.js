/* ============================================================
   PIXEL CLASH — 数据层
   视角坐标：800 x 450（画布按 2x 放大渲染）
   ============================================================ */

const VIEW = { W: 800, H: 450, GROUND: 372 };
const MAX_RAGE = 100;
const RAGE = {
  hit: 8,        // 挥拳 / 踢腿命中：出招方 +8
  hurt: 10,      // 被挥拳 / 踢腿命中：受击方 +10
  block: 12, perfect: 6, whiff: 0,
  /* 技能怒气：cast = 释放即给（空放也给），refund = 完整放完返还，hit = 每段命中，taken = 被命中 */
  s1: { cast: 5, refund: 0, hit: 5, taken: 5 },      // U
  s2: { cast: 0, refund: 5, hit: 10, taken: 10 },    // I
  s3: { cast: 0, refund: 10, hit: 20, taken: 20 }    // O
};
/** 按技能编号取怒气配置（0 = 普攻） */
function skillRage(no) { return no === 1 ? RAGE.s1 : no === 2 ? RAGE.s2 : no === 3 ? RAGE.s3 : null; }

/* 招式帧数据（时间单位：秒）
   next：BVN 式连段链——取消窗口内按 J 接下一式
   launch：命中把对手打上天（浮空，可跳取消追击）
   knockdown：命中直接击飞倒地 */
const MOVES = {
  punch: {
    name: '直拳', startup: 0.07, active: 0.06, recovery: 0.13,
    dmg: 12, reach: 62, hi: -104, lo: -40, kb: 70, hitstun: 0.22, blockstun: 0.12,
    lunge: 26, sfx: 'punch', pose: 'punch', rage: RAGE.hit, next: 'punch2'
  },
  punch2: {
    name: '连击·贰', startup: 0.06, active: 0.06, recovery: 0.13,
    dmg: 12, reach: 62, hi: -108, lo: -40, kb: 70, hitstun: 0.22, blockstun: 0.12,
    lunge: 30, sfx: 'punch', pose: 'punch', rage: RAGE.hit, next: 'punch3'
  },
  punch3: {
    name: '上勾·浮空', startup: 0.1, active: 0.08, recovery: 0.3,
    dmg: 13.2, reach: 62, hi: -142, lo: -30, kb: 60, hitstun: 0.55, blockstun: 0.16,
    lunge: 20, sfx: 'kick', pose: 'punch', rage: RAGE.hit, launch: true
  },
  dashatk: {
    name: '疾步冲拳', startup: 0.08, active: 0.09, recovery: 0.22,
    dmg: 14.4, reach: 62, hi: -102, lo: -36, kb: 250, hitstun: 0.36, blockstun: 0.16,
    lunge: 70, sfx: 'punch', pose: 'punch', rage: RAGE.hit, knockdown: true
  },
  dashkick: {
    name: '瞬步踢', startup: 0.17, active: 0.08, recovery: 0.22,
    dmg: 21.6, reach: 62, hi: -92, lo: -18, kb: 140, hitstun: 0.3, blockstun: 0.16,
    lunge: 18, sfx: 'kick', pose: 'kick', rage: RAGE.hit
  },
  kick: {
    name: '回旋踢', startup: 0.17, active: 0.08, recovery: 0.22,
    dmg: 18, reach: 62, hi: -92, lo: -18, kb: 140, hitstun: 0.3, blockstun: 0.16,
    lunge: 18, sfx: 'kick', pose: 'kick', rage: RAGE.hit
  },
  jpunch: {
    name: '跳拳', startup: 0.06, active: 0.1, recovery: 0.14,
    dmg: 13.2, reach: 62, hi: -72, lo: 12, kb: 90, hitstun: 0.26, blockstun: 0.12,
    lunge: 0, sfx: 'punch', pose: 'jpunch', air: true, rage: RAGE.hit
  },
  jkick: {
    name: '跳踢', startup: 0.09, active: 0.13, recovery: 0.18,
    dmg: 19.8, reach: 62, hi: -64, lo: 16, kb: 170, hitstun: 0.34, blockstun: 0.18,
    lunge: 0, sfx: 'kick', pose: 'jkick', air: true, rage: RAGE.hit
  },
  grabHit: {
    name: '撕咬', startup: 0, active: 0, recovery: 0, dmg: 0, kb: 0, hitstun: 0
  }
};

/* 六名斗士
   skills.s1 = 技能1（U 键，不消耗怒气）
   skills.s2 = 技能2（I 键，消耗 50 怒气）
   skills.s3 = 技能3（O 键，消耗 100 怒气，暂未配置）
   skills.dodge = 幻影闪避（S+L，消耗 50 怒气） */
const CHARACTERS = {
  dog: {
    id: 'dog', name: '大狗', en: 'BIG BARK', tag: '拳犬 · 金毛霸',
    color: '#ffb03a', color2: '#ff6a2a', glow: 'rgba(255,176,58,.75)',
    hp: 1000, speed: 160, jump: 520,
    scale: 0.64,
    bio: '被遗弃在拳馆门口的金毛，靠着看门学会了拳击。一口好牙 + 一副好嗓子。',
    skills: { s1: '野生狗奶', s2: '大狗咬', s3: '大狗叫', dodge: '幻影闪避' },
    desc: {
      s1: '抱起狗奶蓄力掷出，旋转奶砖砸飞对手',
      s2: '冲刺擒抱，把对手放倒连咬三口',
      s3: '咆哮释放三道音波，全场最高伤害',
      dodge: '残影分身，无敌帧闪避'
    },
    elem: '#ffb03a'
  },
  whalie: {
    id: 'whalie', name: '小鲸', en: 'WHALIE', tag: '深海 · 蓝鲸仆',
    color: '#5aa9ff', color2: '#2b57c9', glow: 'rgba(90,169,255,.75)',
    hp: 1000, speed: 160, jump: 520,
    scale: 0.64,
    bio: '深海宅邸的女仆长，随身带着今天的口粮。上得了厅堂，喷得了对手。',
    skills: { s1: '米饭攻击', s2: '水弹术', s3: '鲸歌', dodge: '幻影闪避' },
    desc: {
      s1: '连丢三碗热米饭，砸中把对手击退倒地',
      s2: '张大嘴喷出高压水柱，把对手一路冲到墙角',
      s3: '唱出鲸歌咏叹调，扇形音波三连越打越重',
      dodge: '残影分身，无敌帧闪避'
    },
    elem: '#4fc3f7'
  },
  frost: {
    id: 'frost', name: '霜龙', en: 'FROST', tag: '白鳞 · 霜之龙',
    color: '#bfe4ff', color2: '#7fa6d6', glow: 'rgba(191,228,255,.75)',
    hp: 1000, speed: 160, jump: 520,
    scale: 0.64,
    bio: '北境龙族的幼女，说话很慢，出手很快。不喜欢别人碰她的头发。',
    skills: { s1: '冰晶穿刺', s2: '秘技·龙爪手', s3: '秘技·火球术', dodge: '幻影闪避' },
    desc: {
      s1: '召出贯穿全场的巨型冰晶锥，一路穿透',
      s2: '近身凝出巨龙爪，一爪把对手撕飞',
      s3: '张口喷出炽热火球，持续灼烧对手',
      dodge: '残影分身，无敌帧闪避'
    },
    elem: '#a8e6ff'
  },
  hopper: {
    id: 'hopper', name: '跳跳', en: 'HOPPER', tag: '弹跳 · 黄袋鼠',
    color: '#ffd83d', color2: '#e0a800', glow: 'rgba(255,216,61,.75)',
    hp: 1000, speed: 160, jump: 520,
    scale: 0.64,
    bio: '把尾巴当弹簧用的拳手。速度全场第一，被踢中会很疼。',
    skills: { s1: '百万吨拳踢', s2: '神之一脚', s3: '胆子肥嘟嘟', dodge: '幻影闪避' },
    desc: { s1: '连打数拳，最后一脚踢飞', s2: '跃上高空，带火俯冲连踢，末脚轰飞', s3: '喊完话再丢出外卖车连撞', dodge: '残影分身，无敌帧闪避' },
    elem: '#ffe066'
  },
  naiwa: {
    id: 'naiwa', name: '奶娃', en: 'NAIWA', tag: '重装 · 奶黄怪',
    color: '#f7b733', color2: '#b06a12', glow: 'rgba(247,183,51,.75)',
    hp: 1000, speed: 160, jump: 520,
    scale: 0.64,
    bio: '不知道是什么生物。防御极高，喜欢用肚子接拳头。',
    skills: { s1: '安迪', s2: '嘎嘎滴', s3: '哈哈哈', dodge: '幻影闪避' },
    desc: { s1: '蓄力重拳，把对手打飞很远', s2: '高高跃起，双手合拢砸向地面', s3: '笑得肚子乱颤，环形音波震飞敌人', dodge: '残影分身，无敌帧闪避' },
    elem: '#ff8a4c'
  },
  spade: {
    id: 'spade', name: '黑桃', en: 'SPADE', tag: '拳手 · 黑桃K',
    color: '#b388ff', color2: '#6a3fd6', glow: 'rgba(179,136,255,.75)',
    hp: 1000, speed: 160, jump: 520,
    scale: 0.64,
    bio: '街头拳馆的常客，短打快攻。今天穿的是最舒服的黑色T恤。',
    skills: { s1: '黑桃乱舞', s2: '过肩摔', s3: '抱歉', dodge: '幻影闪避' },
    desc: { s1: '四连快拳贴身压制', s2: '抓人过肩砸地，反弹击飞', s3: '圣光感化敌人，敌人损失的体力一半转化为自身体力', dodge: '残影分身，无敌帧闪避' },
    elem: '#c7a4ff'
  }
};

const ORDER = ['dog', 'whalie', 'frost', 'hopper', 'naiwa', 'spade'];

/* 六名角色的图片、姿势、动作帧和音频统一按角色归档。 */
function characterAsset(id, kind, file) {
  return `assets/characters/${id}/${kind}/${file}`;
}

/* 通用技能（没有专属招式的角色的技能1 / 技能2） */
const GENERIC = {
  rush: { cost: 0, dmg: 22, hits: 4, gap: 0.12, range: 78, name: '' },
  burst: { cost: 50, dmg: 132, speed: 330, name: '' }
};
