import XCTest
import WebKit
@testable import runner

@MainActor
final class IOSBetaUITests: BridgeTestCase {
    func testHomeBadgeAndTerminalInfoFollowActiveTab() async throws {
        let webView = try await editorWebView()
        let home = try await webView.callAsyncJavaScript("""
            await acode.exec('welcome');
            editorManager.getFile('welcome-tab').makeActive();
            const badge=editorManager.getFile('welcome-tab').content.shadowRoot.querySelector('.beta-badge');
            return badge?.textContent === 'Beta' && getComputedStyle(badge).display !== 'none'
                && !editorManager.header.querySelector('[data-action="terminal-info"]');
            """, arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(home, true)
        await capture(webView, name: "iOS home Beta badge")

        defer {
            webView.evaluateJavaScript("document.querySelector('.prompt.alert button')?.click();editorManager.getFile('ios-beta-terminal')?.remove(true);editorManager.getFile('ios-beta-editor')?.remove(true);editorManager.getFile('welcome-tab')?.makeActive();")
        }
        let terminal = try await webView.callAsyncJavaScript("""
            const EditorFile=acode.require('EditorFile');
            const terminal=new EditorFile('Terminal', {id:'ios-beta-terminal',type:'terminal',content:document.createElement('div'),render:true});
            terminal.makeActive();
            const header=editorManager.header;
            const info=header.querySelector('[data-action="terminal-info"]');
            if(!info || header.querySelector('[action="toggle-edit-menu"]')) throw Error('Terminal header actions incorrect');
            if(info.tagName !== 'BUTTON' || getComputedStyle(info).pointerEvents === 'none') throw Error('Info button cannot be clicked');
            if(info.getAttribute('aria-label') !== 'About the iOS terminal') throw Error('Missing accessible label');
            info.click();
            return document.querySelector('.prompt.alert .message').textContent;
            """, arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertTrue(terminal?.contains("emulation") == true)
        XCTAssertTrue(terminal?.contains("slower") == true)
        await capture(webView, name: "iOS terminal emulation info")

        let switches = try await webView.callAsyncJavaScript("""
            document.querySelector('.prompt.alert button').click();
            const EditorFile=acode.require('EditorFile');
            const file=new EditorFile('Example.txt',{id:'ios-beta-editor',text:'',isUnsaved:false,render:true});
            file.makeActive();
            const header=editorManager.header;
            if(header.querySelector('[data-action="terminal-info"]') || !header.querySelector('[action="toggle-edit-menu"]')) return false;
            editorManager.getFile('welcome-tab').makeActive();
            if(header.querySelector('[data-action="terminal-info"]')) return false;
            editorManager.getFile('ios-beta-terminal').makeActive();
            return !!header.querySelector('[data-action="terminal-info"]') && !header.querySelector('[action="toggle-edit-menu"]');
            """, arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(switches, true)
    }

    private func capture(_ webView: WKWebView, name: String) async {
        guard let window = webView.window else { return }
        try? await Task.sleep(for: .milliseconds(250))
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
