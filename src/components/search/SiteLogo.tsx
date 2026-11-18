import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { IconLinkOutline14 } from '../base/icons.js'
import type { Source } from '../../services/chat/view.js'
import styles from './SiteLogo.module.css'

/** 只展示本地图标，不加载 API / 导入归档里的第三方 favicon；保留 url 属性兼容来源元数据。 */
export const SiteLogo = ({
  className,
  style,
}: {
  url: string | null
  className?: string
  style?: CSSProperties
}) => (
  <span className={clsx(styles.logo, className)} style={style} aria-hidden="true">
    <span className={clsx(styles.placeholder, styles.fallback)}>
      <IconLinkOutline14 />
    </span>
  </span>
)

/** 搜索结果前 4 个站点的重叠缩略图 */
export const SiteThumbnails = ({ sources }: { sources: Source[] }) => (
  <span className={styles.group}>
    {sources.slice(0, 4).map((source) => (
      <SiteLogo key={source.url} url={source.siteIcon} className={styles.thumbnail} />
    ))}
  </span>
)
