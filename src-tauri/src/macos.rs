#![cfg(target_os = "macos")]

use std::ffi::c_void;

use objc2::{msg_send, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication, NSBitmapImageRep, NSColor,
    NSDeviceRGBColorSpace, NSGraphicsContext, NSImage, NSImageSymbolConfiguration,
};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString};
use tauri::image::Image;

/// Returns true if NSApplication's effective appearance resolves to dark.
/// Uses `bestMatchFromAppearancesWithNames:` so we also catch vibrant /
/// accessibility-high-contrast variants, not just the bare DarkAqua name.
unsafe fn system_is_dark() -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let app = NSApplication::sharedApplication(mtm);
    let appearance = app.effectiveAppearance();

    // Pass [Aqua, DarkAqua] as the candidate set; macOS picks whichever the
    // current effective appearance is closer to.
    let names: objc2::rc::Retained<NSArray<NSString>> =
        NSArray::from_slice(&[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]);
    let matched: Option<objc2::rc::Retained<NSString>> = msg_send![
        &*appearance,
        bestMatchFromAppearancesWithNames: &*names
    ];
    let Some(matched) = matched else {
        return false;
    };
    let dark: &'static NSString = NSAppearanceNameDarkAqua;
    let is_dark: bool = msg_send![&*matched, isEqualToString: dark];
    is_dark
}

/// Render an SF Symbol to a 16×16 RGBA bitmap suitable for menu item icons.
///
/// Returns `None` if the symbol name is unavailable on the current system
/// (e.g. running on a macOS version older than the symbol's introduction).
///
/// The color is baked in at startup time via `NSImageSymbolConfiguration`'s
/// hierarchical color — drawing into an `NSBitmapImageRep` graphics context
/// would otherwise resolve dynamic colors (controlTextColor, labelColor)
/// against the Aqua default, producing a black icon even in dark mode.
/// Switching system appearance mid-session won't repaint the cached bitmap.
pub fn sf_symbol_image(name: &str) -> Option<Image<'static>> {
    const SIZE: f64 = 16.0;
    const PX: u32 = 16;

    unsafe {
        let symbol_name = NSString::from_str(name);
        let nsimg = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &symbol_name,
            None,
        )?;
        nsimg.setSize(NSSize::new(SIZE, SIZE));

        // Bake the tint color into the symbol so it renders the same color
        // regardless of destination context appearance. Use a palette
        // configuration with a single color: this forces flat monochrome
        // rendering (no hierarchical opacity steps), matching how Ghostty
        // and other native macOS apps draw Copy/Paste icons.
        let tint = if system_is_dark() {
            NSColor::whiteColor()
        } else {
            NSColor::blackColor()
        };
        let palette: objc2::rc::Retained<NSArray<NSColor>> = NSArray::from_slice(&[&*tint]);
        let config = NSImageSymbolConfiguration::configurationWithPaletteColors(&palette);
        let tinted = nsimg.imageWithSymbolConfiguration(&config)?;
        tinted.setSize(NSSize::new(SIZE, SIZE));

        // Create an empty RGBA bitmap. Passing a null planes pointer asks
        // AppKit to allocate the backing bytes for us.
        let bitmap_rep =
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                PX as isize,
                PX as isize,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )?;

        let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap_rep)?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&ctx));

        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(SIZE, SIZE));
        tinted.drawInRect(rect);

        NSGraphicsContext::restoreGraphicsState_class();

        let row_bytes = bitmap_rep.bytesPerRow() as usize;
        let bitmap_data = bitmap_rep.bitmapData();
        if bitmap_data.is_null() {
            return None;
        }
        let total = row_bytes * PX as usize;
        let slice = std::slice::from_raw_parts(bitmap_data, total);

        // Repack to a tight 4 bytes/row × 16 buffer in case AppKit aligned
        // the row stride.
        let tight_stride = (PX as usize) * 4;
        let mut rgba = Vec::with_capacity(tight_stride * PX as usize);
        for row in 0..PX as usize {
            let start = row * row_bytes;
            rgba.extend_from_slice(&slice[start..start + tight_stride]);
        }

        Some(Image::new_owned(rgba, PX, PX))
    }
}

/// Disable WKWebView's Writing Tools integration. macOS Sequoia injects
/// "Writing Tools" (and a handful of other system items) into any Edit menu
/// whenever the focused responder advertises that it supports them. Setting
/// the behavior to `.none` opts out, which removes those injected items
/// from our menu bar.
///
/// The setter is declared on `NSTextCheckingClient` / `NSTextView`; in
/// macOS 15+ `WKWebView` conforms to the protocol and exposes the
/// property, but `objc2-web-kit` 0.3.2 doesn't bind it statically yet, so
/// we send the selector dynamically. On older macOS the message is a no-op.
pub fn disable_writing_tools(wkwebview_ptr: *mut c_void) {
    if wkwebview_ptr.is_null() {
        return;
    }
    unsafe {
        let obj = wkwebview_ptr as *mut objc2::runtime::AnyObject;
        let sel = objc2::sel!(setWritingToolsBehavior:);
        // -1 == NSWritingToolsBehavior.None
        let responds: bool = msg_send![&*obj, respondsToSelector: sel];
        if responds {
            let _: () = msg_send![&*obj, setWritingToolsBehavior: -1isize];
        }
    }
}
