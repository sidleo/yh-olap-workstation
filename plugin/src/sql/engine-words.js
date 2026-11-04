// ===== WORKSTATION: 引擎词表（纯 ESM，无依赖）=====
// 供编辑器语法高亮 / 补全复用（CodeMirror 侧直接 import，不依赖 React / DOM）。
//
// 数据来源：
//   - 关键字：Impala 3.4 / Hive 3.1 官方 reserved + 常用关键字（多词关键字如 'group by' 保留完整条目）。
//   - 函数：2026-09-01 逐函数 olap.run 实测清单（页面清单仅参考，以实际执行为准）——“impala”与“hive”
//     函数集有真实差异（如 impala 有 ndv/current_database，hive 有 collect_list/get_json_object）。
//   - 类型：两引擎公共 SQL 类型。
//
// 修复的历史 bug（2026-09 实测）：client.js 里旧词表用一元 `+` 拼接首个字符串字面量，
// 得到 NaN 后再与后续字符串相加 → IMPALA_FUNCS[0] === 'NaNceil'、HIVE_FUNCS[0] === 'NaNbtrim'，
// 首行函数全丢；且字符串行之间缺空格 → 'current_databasecurrent_timestamp' 这类粘连 token。
// 这里改为「模板字符串 + split(/\s+/) / 逗号分隔 + split(',')」，再统一小写、去空白、去重。
//
// 统一约定：keywords / functions / types 全部为「小写、去重、已 trim」的字符串数组；
// keywords 中多词条目（如 'compute stats'）保留为一个元素，逐词高亮匹配用 expandKeywords() 展开。

const COMMON_TYPES = parseWordList(
  'int bigint smallint tinyint string varchar char double float boolean timestamp date decimal array map struct binary'
)

const SQL_COMMON_KEYS = 'select from where group by order limit insert into values update set delete create table drop alter join inner left right full outer on as and or not in is null like between case when then else end union all distinct having partition over'
const SQL_COMMON_FUNCS = 'count sum avg min max round coalesce cast substr substring concat concat_ws upper lower trim datediff date_add date_sub year month day now current_date to_date from_unixtime unix_timestamp nvl if'

// ===== Impala 3.4 =====
const IMPALA_KEYS_RAW = (
    'select,from,where,group by,order by,having,limit,offset,union all,distinct,'
  + 'insert into,values,overwrite,update,delete,with,as,create table,alter,drop,'
  + 'truncate,describe,desc,show,use,set,join,inner join,left join,right join,'
  + 'full outer join,cross join,left semi join,left anti join,on,using,and,or,not,in,'
  + 'is,null,like,ilike,rlike,regexp,between,exists,case,when,'
  + 'then,else,end,cast,if,coalesce,nvl,nullif,partition by,over,'
  + 'rows,range,unbounded,preceding,following,current row,compute stats,refresh,invalidate metadata,kudu,'
  + 'explain,profile,grant,revoke,primary key,foreign key,unique,format,parquet,orc,'
  + 'avro,textfile,sequencefile,jsonfile,transaction,transactional,acid,restrict,cascade,comment,'
  + 'properties,serdeproperties,tblproperties,into path,load data,show databases,show schemas,show tables,show columns,show functions,'
  + 'analyze,insert,count,sum,avg,min,max,aggregate,'
)

const IMPALA_FUNCS_RAW = `
abs acos add_months appx_median ascii asin atan avg bin bitand bitnot bitor bitxor cast
ceil ceiling char_length character_length chr coalesce concat concat_ws conv cos count countset cume_dist current_date current_database
current_timestamp current_user date_add date_sub date_trunc datediff day dayname dayofmonth dayofweek dayofyear degrees dense_rank e
exp extract factorial find_in_set first_value floor from_unixtime from_utc_timestamp get_json_object greatest group_concat hex hour if
initcap instr lag last_day last_value lcase lead least length levenshtein ln locate log log10
log2 logged_in_user lower lpad ltrim mask mask_first_n mask_hash mask_last_n mask_show_first_n mask_show_last_n max min minute
mod month months_between ndv negative now ntile nullif nvl parse_url percent_rank pi pmod positive
pow power quarter radians rand rank round row_number second shiftleft shiftright sign sin split_part
sqrt stddev_pop stddev_samp sum tan to_date to_utc_timestamp trunc unhex unix_timestamp uuid var_pop var_samp variance
version weekofyear width_bucket year
`

// ===== Hive 3.1 =====
const HIVE_KEYS_RAW = (
    'select,from,where,group by,having,order by,limit,offset,cluster by,distribute by,'
  + 'sort by,union all,insert into,insert overwrite,table,values,create database,create schema,create table,create view,'
  + 'create index,create function,create macro,alter,drop,truncate,describe,desc,show,use,'
  + 'set,add jar,add file,add archive,join,inner join,left join,right join,full outer join,cross join,'
  + 'left semi join,on,using,and,or,not,in,is,null,like,'
  + 'rlike,regexp,between,exists,case,when,then,else,end,cast,'
  + 'partition by,clustered by,sorted by,into buckets,lateral view,explode,posexplode,inline,stack,stored as,'
  + 'orc,parquet,avro,textfile,sequencefile,rcfile,jsonfile,row format,serde,fields terminated by,'
  + 'lines terminated by,collection,map keys,location,comment,tblproperties,serdeproperties,if,coalesce,nvl,'
  + 'nullif,over,rows,range,unbounded,preceding,following,current row,with,as,'
  + 'export,import,msck repair,analyze,grant,revoke,transaction,transactional,distinct,all,'
  + 'date,timestamp,decimal,array,map,struct,load data,local,inpath,primary key,'
  + 'foreign key,'
)

const HIVE_FUNCS_RAW = `
abs acos add_months adddate array array_contains ascii asin atan atan2 avg base64decode base64encode bin
btrim cast ceil ceiling char_length character_length chr coalesce collect_list collect_set concat concat_ws conv corr
cos cosh cot count crc32 cume_dist current_database current_date current_timestamp current_user date_add date_format date_part date_sub
datediff day dayofmonth dayofweek days_add days_sub dceil decode degrees dense_rank dexp dfloor dlog1 dpow
dround dsqrt dtrunc e exp explode extract factorial find_in_set first_value floor fmod fnv_hash fpow
from_timestamp from_unixtime from_utc_timestamp get_json_object greatest hex hour hours_add hours_sub if initcap instr int_months_between is_inf
is_nan isfalse isnotfalse isnottrue isnull istrue json_tuple lag last_day last_value lcase lead least length levenshtein
ln locate log log10 log2 logged_in_user lower lpad ltrim map map_keys max max_bigint max_int
max_smallint max_tinyint md5 microseconds_add min min_bigint min_int min_smallint min_tinyint minute minutes_add mod month months_add
months_between murmur_hash named_struct negative next_day nonnullvalue ntile nullif nullvalue nvl parse_url percent_rank percentile pi
pmod posexplode positive pow power precision printf quarter quotient radians rand rank regexp_extract regexp_replace
repeat replace reverse round row_number rpad rtrim second seconds_add sentences shiftleft shiftright sha2 sign sin size
sort_array soundex space split split_part sqrt stack stddev stddev_pop stddev_samp str_to_map substr substring substring_index
sum tan to_date to_utc_timestamp translate trim trunc ucase unhex unix_timestamp upper user uuid var_pop
var_samp variance variance_pop variance_samp version weekofyear width_bucket year years_add
`

// 单条词规范化：合并内部空白、trim、小写；空串返回 ''
function normWord(entry) {
  return String(entry == null ? '' : entry).replace(/\s+/g, ' ').trim().toLowerCase()
}

// 去空、去重、小写（保持首次出现的顺序）
function uniqWords(entries) {
  const out = []
  const seen = new Set()
  for (const entry of entries) {
    const w = normWord(entry)
    if (!w || seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out
}

// 逗号分隔的关键字（多词关键字内部的空格保留）
function parseKeyList(raw) {
  return uniqWords(String(raw == null ? '' : raw).split(','))
}

// 空白分隔的词表（函数 / 类型）
function parseWordList(raw) {
  return uniqWords(String(raw == null ? '' : raw).split(/\s+/))
}

function makeEngine(keywordsRaw, functionsRaw) {
  return {
    keywords: parseKeyList(keywordsRaw),
    functions: parseWordList(functionsRaw),
    types: COMMON_TYPES.slice(),
  }
}

export const IMPALA = makeEngine(IMPALA_KEYS_RAW, IMPALA_FUNCS_RAW)
export const HIVE = makeEngine(HIVE_KEYS_RAW, HIVE_FUNCS_RAW)
export const DEFAULT = {
  keywords: parseWordList(SQL_COMMON_KEYS),
  functions: parseWordList(SQL_COMMON_FUNCS),
  types: COMMON_TYPES.slice(),
}

// 引擎编号 → 词表：'1'=hive、'2'=impala（与面板 engine 字段一致），其余统一回退通用 SQL
export const ENGINE_WORDS = {
  '1': HIVE,
  '2': IMPALA,
  '3': DEFAULT,
  '4': DEFAULT,
  default: DEFAULT,
}

// 未知 / 缺省引擎回退 DEFAULT（返回词表对象本身，调用方可直接解构 keywords/functions/types）
export function engineWords(engine) {
  return ENGINE_WORDS[String(engine)] || ENGINE_WORDS.default
}

// 多词关键字（'group by' / 'compute stats'）展开为逐词集合，供高亮按 token 匹配：
// 同时保留完整短语（'group by'）与拆出的单词（'group'、'by'），全部小写、去重。
export function expandKeywords(list) {
  const set = new Set()
  const entries = typeof list === 'string' ? list.split(',') : (Array.isArray(list) ? list : [])
  for (const entry of entries) {
    const full = normWord(entry)
    if (!full) continue
    set.add(full)
    for (const w of full.split(' ')) if (w) set.add(w)
  }
  return set
}
