use tauri::ipc::{InvokeBody, Request, Response};

fn encode_rgba(pixels: &[u8], width: u32, height: u32, quality: f32) -> Result<Vec<u8>, String> {
  if width == 0 || height == 0 || width > 16383 || height > 16383 {
    return Err("WebP dimensions must be between 1 and 16383 pixels.".into());
  }
  if !quality.is_finite() || !(1.0..=100.0).contains(&quality) {
    return Err("Quality must be between 1 and 100.".into());
  }
  if pixels.len() != width as usize * height as usize * 4 {
    return Err("The image pixel data does not match its dimensions.".into());
  }

  webp::Encoder::from_rgba(pixels, width, height)
    .encode_simple(false, quality)
    .map(|encoded| encoded.to_vec())
    .map_err(|error| format!("WebP encoding failed: {error:?}"))
}

// Raw IPC keeps large pixel buffers out of JSON number arrays.
#[tauri::command]
pub async fn encode_webp(request: Request<'_>) -> Result<Response, String> {
  let header = |name| {
    request
      .headers()
      .get(name)
      .and_then(|value| value.to_str().ok())
      .ok_or_else(|| format!("Missing image header: {name}"))
  };
  let width = header("x-image-width")?
    .parse()
    .map_err(|_| "Invalid image width.")?;
  let height = header("x-image-height")?
    .parse()
    .map_err(|_| "Invalid image height.")?;
  let quality = header("x-image-quality")?
    .parse()
    .map_err(|_| "Invalid image quality.")?;
  let InvokeBody::Raw(pixels) = request.body() else {
    return Err("Image pixels must be sent as binary data.".into());
  };

  encode_rgba(pixels, width, height, quality).map(Response::new)
}

#[cfg(test)]
mod tests {
  use super::encode_rgba;

  #[test]
  fn encodes_real_webp_with_dimensions_alpha_and_requested_quality() {
    let mut pixels = Vec::new();
    for y in 0..32 {
      for x in 0..48 {
        pixels.extend_from_slice(&[(x * 5) as u8, (y * 7) as u8, (x * y) as u8, (x * 5) as u8]);
      }
    }
    let low = encode_rgba(&pixels, 48, 32, 10.0).unwrap();
    let high = encode_rgba(&pixels, 48, 32, 95.0).unwrap();
    assert_ne!(low, high);
    for bytes in [low, high] {
      assert_eq!(&bytes[..4], b"RIFF");
      assert_eq!(&bytes[8..12], b"WEBP");
      let decoded = webp::Decoder::new(&bytes).decode().unwrap();
      assert_eq!((decoded.width(), decoded.height()), (48, 32));
      assert!(webp::BitstreamFeatures::new(&bytes).unwrap().has_alpha());
    }
  }

  #[test]
  fn rejects_invalid_input_without_panicking() {
    assert!(encode_rgba(&[], 1, 1, 80.0).is_err());
    assert!(encode_rgba(&[], 0, 1, 80.0).is_err());
    assert!(encode_rgba(&[], 16384, 1, 80.0).is_err());
    assert!(encode_rgba(&[0; 4], 1, 1, f32::NAN).is_err());
  }
}
