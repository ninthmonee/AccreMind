import sys
from playwright.sync_api import sync_playwright
theme = sys.argv[1] if len(sys.argv) > 1 else 'light'
with sync_playwright() as p:
    b=p.chromium.launch()
    for name,vp in [('desk',{'width':1440,'height':900}),('mobile',{'width':390,'height':844})]:
        ctx=b.new_context(viewport=vp, color_scheme=theme)
        pg=ctx.new_page()
        errs=[]; pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('http://127.0.0.1:3199/'); pg.wait_for_timeout(1200)
        pg.screenshot(path=f'shots/{theme}-{name}-empty.png')
        pg.locator('[data-work-action="demo"]').first.click(); pg.wait_for_timeout(2500)
        pg.screenshot(path=f'shots/{theme}-{name}-home.png', full_page=True)
        pg.locator('[data-nav="kb"]').first.click(); pg.wait_for_timeout(1200)
        pg.screenshot(path=f'shots/{theme}-{name}-kb.png', full_page=(name=='desk'))
        for nav in ['review','reactor','gov']:
            pg.locator(f'[data-nav="{nav}"]').first.click(); pg.wait_for_timeout(1300)
            if nav=='reactor':
                btn=pg.locator('#btn-run-reactor')
                if btn.is_visible(): btn.click(); pg.wait_for_timeout(1000)
            pg.screenshot(path=f'shots/{theme}-{name}-{nav}.png', full_page=(name=='desk'))
        pg.locator('[data-nav="kb"]').first.click(); pg.wait_for_timeout(1000)
        t=pg.locator('.vc-title, .knowledge-title').first
        if t.count(): t.click(); pg.wait_for_timeout(1000); pg.screenshot(path=f'shots/{theme}-{name}-drawer.png')
        print(theme, name, 'errors', errs[:6])
        ctx.close()
    b.close()
